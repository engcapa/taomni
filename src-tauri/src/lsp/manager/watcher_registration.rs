//! Blocking OS watcher setup and filtering, independent of provider lifetime.
use crate::lsp::WorkspaceWatchTarget;
use crate::lsp::watcher::{
    normalized_file_operation_path, normalized_watch_path_is_under, workspace_watch_target_matches,
};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use tokio_util::sync::CancellationToken;

pub(in crate::lsp) struct RegisteredWorkspaceWatcher {
    pub watcher: RecommendedWatcher,
    pub events: UnboundedReceiver<notify::Result<Event>>,
    pub targets: Vec<WorkspaceWatchTarget>,
    pub ignored_paths: Vec<String>,
}

pub(in crate::lsp) fn application_paths(app: Option<&tauri::AppHandle>) -> Vec<PathBuf> {
    let Some(app) = app else { return Vec::new() };
    [
        crate::resolved_app_data_dir(app).ok(),
        app.path().app_data_dir().ok(),
        app.path().app_local_data_dir().ok(),
        app.path().app_config_dir().ok(),
        app.path().app_cache_dir().ok(),
        app.path().app_log_dir().ok(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub(in crate::lsp) fn event_path_allowed(
    targets: &[WorkspaceWatchTarget],
    ignored_paths: &[String],
    path: &str,
) -> bool {
    if !workspace_watch_target_matches(targets, path) {
        return false;
    }
    !ignored_paths.iter().any(|ignored| {
        normalized_watch_path_is_under(ignored, path)
            // Explicitly opening a folder/file in application data still has
            // normal explorer semantics. Only broad ancestor roots suppress it.
            && !targets.iter().any(|target| {
                normalized_watch_path_is_under(
                    ignored,
                    &normalized_file_operation_path(&target.filter_path),
                ) && workspace_watch_target_matches(std::slice::from_ref(target), path)
            })
    })
}

/// Run on spawn_blocking: notify's recursive registration performs filesystem I/O.
pub(in crate::lsp) fn register(
    roots: Vec<String>,
    directories: Vec<String>,
    ignored_paths: Vec<PathBuf>,
    cancelled: CancellationToken,
) -> Result<RegisteredWorkspaceWatcher, String> {
    register_with_home(
        roots,
        directories,
        ignored_paths,
        dirs::home_dir(),
        cancelled,
    )
}

pub(in crate::lsp) fn register_with_home(
    roots: Vec<String>,
    directories: Vec<String>,
    ignored_paths: Vec<PathBuf>,
    home: Option<PathBuf>,
    cancelled: CancellationToken,
) -> Result<RegisteredWorkspaceWatcher, String> {
    let mut targets = Vec::new();
    let mut errors = Vec::new();
    let mut registrations: HashMap<String, (PathBuf, bool, Vec<String>)> = HashMap::new();
    let home = home.as_deref().map(normalized_file_operation_path);
    for (root, directory) in roots
        .into_iter()
        .map(|root| (root, false))
        .chain(directories.into_iter().map(|root| (root, true)))
    {
        if cancelled.is_cancelled() {
            return Err("workspace watcher initialization cancelled".into());
        }
        let requested = PathBuf::from(&root);
        let is_directory = requested.is_dir();
        let is_home = home.as_deref().is_some_and(|home| {
            crate::lsp::watcher::normalized_watch_path_equals(
                home,
                &normalized_file_operation_path(&requested),
            )
        });
        let direct_children = is_directory && (directory || is_home);
        let (watch_path, recursive) = if is_directory {
            (requested.clone(), !direct_children)
        } else if let Some(parent) = requested.parent().filter(|parent| parent.is_dir()) {
            // Watch the parent of existing files too: inode watches disappear
            // on atomic replacement, while parent watches observe the new file.
            (parent.to_path_buf(), false)
        } else {
            errors.push(format!("{root}: parent directory does not exist"));
            continue;
        };
        let mut key = normalized_file_operation_path(&watch_path);
        if cfg!(windows) {
            key.make_ascii_lowercase();
        }
        let registration = registrations
            .entry(key)
            .or_insert_with(|| (watch_path, false, Vec::new()));
        registration.1 |= recursive;
        registration.2.push(root);
        targets.push(WorkspaceWatchTarget {
            recursive,
            direct_children,
            filter_path: requested,
        });
    }
    let ignored_paths = ignored_paths
        .iter()
        .map(|path| normalized_file_operation_path(path))
        .collect::<Vec<_>>();
    let callback_targets = targets.clone();
    let callback_ignored = ignored_paths.clone();
    let (sender, events) = unbounded_channel();
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<Event>| {
            // Discard private state/cache writes before they enter the async queue.
            // Keep mixed rename events intact; each derived change is filtered later.
            if event.as_ref().is_ok_and(|event| {
                !event.paths.iter().any(|path| {
                    event_path_allowed(
                        &callback_targets,
                        &callback_ignored,
                        &normalized_file_operation_path(path),
                    )
                })
            }) {
                return;
            }
            let _ = sender.send(event);
        },
        Config::default(),
    )
    .map_err(|error| format!("cannot initialize workspace file watcher: {error}"))?;
    let mut registrations = registrations.into_values().collect::<Vec<_>>();
    registrations.sort_by(|a, b| a.0.cmp(&b.0));
    let mut watched = 0;
    for (path, recursive, roots) in registrations {
        if cancelled.is_cancelled() {
            return Err("workspace watcher initialization cancelled".into());
        }
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        match watcher.watch(Path::new(&path), mode) {
            Ok(()) => watched += 1,
            Err(error) => errors.push(format!("{}: {error}", roots.join(", "))),
        }
    }
    if cancelled.is_cancelled() {
        return Err("workspace watcher initialization cancelled".into());
    }
    if watched == 0 {
        return Err(format!(
            "cannot watch workspace roots: {}",
            errors.join("; ")
        ));
    }
    if !errors.is_empty() {
        log::warn!(
            "workspace watcher started with unavailable roots: {}",
            errors.join("; ")
        );
    }
    Ok(RegisteredWorkspaceWatcher {
        watcher,
        events,
        targets,
        ignored_paths,
    })
}
