use crate::lsp::LocalWatchedEvent;
use crate::lsp::LspExternalFileChangeEvent;
use crate::lsp::LspManager;
use crate::lsp::WorkspaceWatchTarget;
use crate::lsp::WorkspaceWatcherHandle;
use crate::lsp::edit_types::LspWatchedFileChange;
use crate::lsp::watcher;
use crate::lsp::watcher::local_watched_event_suppressed;
use crate::lsp::watcher::local_watched_snapshot;
use crate::lsp::watcher::normalized_file_operation_path;
use crate::lsp::watcher::notify_event_changes;
use crate::lsp::watcher::notify_watched_file_sessions;
use crate::lsp::watcher::workspace_watch_target_matches;
use notify::Config as NotifyConfig;
use notify::RecommendedWatcher;
use notify::RecursiveMode;
use notify::Watcher;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

impl LspManager {
    pub(in crate::lsp) async fn stop_workspace_watcher(&self, workspace_id: &str) {
        let handle = self.workspace_watchers.lock().await.remove(workspace_id);
        let Some(mut handle) = handle else {
            return;
        };
        if let Some(stop) = handle.stop.take() {
            let _ = stop.send(());
        }
        handle.task.abort();
    }

    pub(in crate::lsp) async fn start_workspace_watcher(
        &self,
        workspace_id: &str,
        roots: Vec<String>,
    ) -> Result<(), String> {
        let mut roots = roots
            .into_iter()
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty())
            .collect::<Vec<_>>();
        roots.sort();
        roots.dedup();
        for root in &roots {
            if !Path::new(root).is_absolute() {
                return Err(format!(
                    "workspace watcher requires an absolute root path: {root}"
                ));
            }
        }
        self.stop_workspace_watcher(workspace_id).await;
        if roots.is_empty() {
            return Ok(());
        }

        let (event_sender, mut event_receiver) = mpsc::unbounded_channel();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                let _ = event_sender.send(event);
            },
            NotifyConfig::default(),
        )
        .map_err(|error| format!("cannot initialize workspace file watcher: {error}"))?;
        let mut watched_roots = 0;
        let mut root_errors = Vec::new();
        let mut watch_targets = Vec::new();
        let mut watch_registrations: HashMap<String, (PathBuf, bool, Vec<String>)> = HashMap::new();
        for root in &roots {
            let requested = PathBuf::from(root);
            let (watch_path, recursive, filter_path) = if requested.is_dir() {
                (requested.clone(), true, requested)
            } else if requested.exists() {
                // notify accepts files on all supported backends, but recursive
                // mode is rejected by some platform watchers for a file path.
                (requested.clone(), false, requested)
            } else if let Some(parent) = requested.parent().filter(|parent| parent.is_dir()) {
                // A loose file can be deleted before the workspace opens it. Keep
                // watching its parent so a later recreate is observable, while
                // filtering sibling events below.
                (parent.to_path_buf(), false, requested)
            } else {
                root_errors.push(format!("{root}: parent directory does not exist"));
                continue;
            };
            let mut registration_key = normalized_file_operation_path(&watch_path);
            if cfg!(windows) {
                registration_key.make_ascii_lowercase();
            }
            let registration = watch_registrations
                .entry(registration_key)
                .or_insert_with(|| (watch_path, false, Vec::new()));
            registration.1 |= recursive;
            registration.2.push(root.clone());
            watch_targets.push(WorkspaceWatchTarget {
                recursive,
                filter_path,
            });
        }
        let mut watch_registrations = watch_registrations.into_values().collect::<Vec<_>>();
        watch_registrations.sort_by(|left, right| {
            normalized_file_operation_path(&left.0).cmp(&normalized_file_operation_path(&right.0))
        });
        for (watch_path, recursive, requested_roots) in watch_registrations {
            let mode = if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            match watcher.watch(&watch_path, mode) {
                Ok(()) => watched_roots += 1,
                Err(error) => root_errors.push(format!("{}: {error}", requested_roots.join(", "))),
            }
        }
        if watched_roots == 0 {
            return Err(format!(
                "cannot watch workspace roots: {}",
                root_errors.join("; ")
            ));
        }

        let (stop_sender, mut stop_receiver) = oneshot::channel();
        let workspace_id = workspace_id.to_string();
        let watcher_workspace_id = workspace_id.clone();
        let sessions = self.sessions.clone();
        let client_bridge = self.client_bridge.clone();
        let local_events = self.local_watched_events.clone();
        let task = tokio::spawn(async move {
            // Keep the watcher alive for the lifetime of this task.
            let _watcher = watcher;
            let mut recent_external: HashMap<(String, u8), Instant> = HashMap::new();
            loop {
                tokio::select! {
                    _ = &mut stop_receiver => break,
                    event = event_receiver.recv() => {
                        let Some(event) = event else { break; };
                        let Ok(event) = event else {
                            log::warn!("workspace file watcher failed: {event:?}");
                            continue;
                        };
                        let changes = notify_event_changes(&event);
                        if changes.is_empty() {
                            continue;
                        }
                        let changes = changes
                            .into_iter()
                            .filter(|change| {
                                workspace_watch_target_matches(&watch_targets, &change.path)
                            })
                            .collect::<Vec<_>>();
                        if changes.is_empty() {
                            continue;
                        }
                        let now = Instant::now();
                        recent_external.retain(|_, seen| now.duration_since(*seen) < Duration::from_millis(250));
                        let mut forwarded = Vec::new();
                        for change in changes {
                            let key = (change.path.clone(), change.change_type);
                            let locally_emitted = local_watched_event_suppressed(
                                &local_events,
                                &watcher_workspace_id,
                                &change.path,
                                change.change_type,
                                now,
                            );
                            if locally_emitted || recent_external.contains_key(&key) {
                                continue;
                            }
                            recent_external.insert(key, now);
                            forwarded.push(change);
                        }
                        if forwarded.is_empty() {
                            continue;
                        }
                        for change in &forwarded {
                            client_bridge.emit_external_file_change(LspExternalFileChangeEvent {
                                workspace_id: watcher_workspace_id.clone(),
                                path: change.path.clone(),
                                change_type: change.change_type,
                            });
                        }
                        let _ = notify_watched_file_sessions(&sessions, &watcher_workspace_id, &forwarded).await;
                    }
                }
            }
        });
        self.workspace_watchers.lock().await.insert(
            workspace_id,
            WorkspaceWatcherHandle {
                stop: Some(stop_sender),
                task,
            },
        );
        if !root_errors.is_empty() {
            log::warn!(
                "workspace watcher started with unavailable roots: {}",
                root_errors.join("; ")
            );
        }
        Ok(())
    }

    pub(in crate::lsp) fn mark_local_watched_events(
        &self,
        workspace_id: &str,
        changes: &[LspWatchedFileChange],
    ) {
        let now = Instant::now();
        let snapshots = changes
            .iter()
            .filter_map(|change| {
                local_watched_snapshot(Path::new(&change.path)).map(|snapshot| (change, snapshot))
            })
            .collect::<Vec<_>>();
        let mut local = self
            .local_watched_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        local.retain(|_, event| now.duration_since(event.at) < Duration::from_secs(3));
        for (change, snapshot) in snapshots {
            let path = normalized_file_operation_path(Path::new(&change.path));
            let mut event_types = vec![change.change_type];
            // Atomic replacement is reported as Create/Remove by some notify
            // backends even though the logical operation is Changed. Mark the
            // equivalent variants for the short local-event suppression window.
            if change.change_type == 2 {
                event_types.extend([1, 3]);
            } else {
                event_types.push(2);
            }
            for change_type in event_types {
                local.insert(
                    (workspace_id.to_string(), path.clone(), change_type),
                    LocalWatchedEvent {
                        at: now,
                        snapshot: snapshot.clone(),
                    },
                );
            }
        }
    }

    pub(in crate::lsp) async fn did_change_watched_files(
        &self,
        workspace_id: &str,
        changes: &[LspWatchedFileChange],
    ) -> usize {
        if changes.is_empty() {
            return 0;
        }
        self.mark_local_watched_events(workspace_id, changes);
        notify_watched_file_sessions(&self.sessions, workspace_id, changes).await
    }
}
