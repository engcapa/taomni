use super::watcher_registration;
use crate::lsp::LocalWatchedEvent;
use crate::lsp::LspExternalFileChangeEvent;
use crate::lsp::LspManager;
use crate::lsp::WorkspaceWatcherHandle;
use crate::lsp::edit_types::LspWatchedFileChange;
use crate::lsp::watcher;
use crate::lsp::watcher::local_watched_event_suppressed;
use crate::lsp::watcher::local_watched_snapshot;
use crate::lsp::watcher::normalized_file_operation_path;
use crate::lsp::watcher::notify_event_changes;
use crate::lsp::watcher::notify_watched_file_sessions;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

impl LspManager {
    pub(in crate::lsp) async fn stop_workspace_watcher(&self, workspace_id: &str) {
        let handle = self.workspace_watchers.lock().await.remove(workspace_id);
        let Some(handle) = handle else {
            return;
        };
        handle.cancelled.cancel();
        handle.task.abort();
    }

    pub(in crate::lsp) async fn start_workspace_watcher(
        &self,
        workspace_id: &str,
        roots: Vec<String>,
    ) -> Result<(), String> {
        self.start_workspace_watcher_with_directories(workspace_id, roots, Vec::new())
            .await
    }

    pub(in crate::lsp) async fn start_workspace_watcher_with_directories(
        &self,
        workspace_id: &str,
        roots: Vec<String>,
        directories: Vec<String>,
    ) -> Result<(), String> {
        let mut roots = roots
            .into_iter()
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty())
            .collect::<Vec<_>>();
        roots.sort();
        roots.dedup();
        for root in roots.iter().chain(directories.iter()) {
            if !Path::new(root).is_absolute() {
                return Err(format!(
                    "workspace watcher requires an absolute root path: {root}"
                ));
            }
        }
        let ignored_paths = watcher_registration::application_paths(self.client_bridge.app.get());
        // Publish ownership before waiting on OS setup. Stop/restart cancels the
        // same token while a blocking registration is still in flight.
        let mut watchers = self.workspace_watchers.lock().await;
        if let Some(previous) = watchers.remove(workspace_id) {
            previous.cancelled.cancel();
            previous.task.abort();
        }
        if roots.is_empty() && directories.is_empty() {
            return Ok(());
        }
        let cancelled = CancellationToken::new();
        let task_cancelled = cancelled.clone();
        let (initialized_sender, initialized_receiver) = oneshot::channel();
        let workspace_id = workspace_id.to_string();
        let watcher_workspace_id = workspace_id.clone();
        let sessions = self.sessions.clone();
        let client_bridge = self.client_bridge.clone();
        let local_events = self.local_watched_events.clone();
        let task = tokio::spawn(async move {
            let registration_cancelled = task_cancelled.clone();
            let registration = tokio::task::spawn_blocking(move || {
                watcher_registration::register(
                    roots,
                    directories,
                    ignored_paths,
                    registration_cancelled,
                )
            })
            .await
            .map_err(|error| format!("workspace watcher worker failed: {error}"))
            .and_then(|result| result);
            let registered = match registration {
                Ok(registered) => registered,
                Err(error) => {
                    let _ = initialized_sender.send(Err(error));
                    return;
                }
            };
            let _watcher = registered.watcher;
            let mut event_receiver = registered.events;
            let watch_targets = registered.targets;
            let ignored_paths = registered.ignored_paths;
            let _ = initialized_sender.send(Ok(()));
            let mut recent_external: HashMap<(String, u8), Instant> = HashMap::new();
            loop {
                tokio::select! {
                    _ = task_cancelled.cancelled() => break,
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
                                watcher_registration::event_path_allowed(&watch_targets, &ignored_paths, &change.path)
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
        let task_id = task.id();
        watchers.insert(
            workspace_id.clone(),
            WorkspaceWatcherHandle { cancelled, task },
        );
        drop(watchers);
        let result = initialized_receiver
            .await
            .unwrap_or_else(|_| Err("workspace watcher initialization cancelled".into()));
        if result.is_err() {
            let mut watchers = self.workspace_watchers.lock().await;
            if watchers
                .get(&workspace_id)
                .is_some_and(|handle| handle.task.id() == task_id)
            {
                if let Some(handle) = watchers.remove(&workspace_id) {
                    handle.cancelled.cancel();
                    handle.task.abort();
                }
            }
        }
        result
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
