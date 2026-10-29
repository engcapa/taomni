use super::*;
use crate::lsp::manager::watcher_registration::{event_path_allowed, register, register_with_home};
use tokio_util::sync::CancellationToken;

#[test]
fn broad_root_ignores_only_application_state_with_path_boundaries() {
    let roots = [WorkspaceWatchTarget {
        recursive: true,
        direct_children: false,
        filter_path: "/users/qa".into(),
    }];
    let ignored = vec!["/users/qa/.local/share/com.taomni.app.qa".into()];
    assert!(!event_path_allowed(
        &roots,
        &ignored,
        "/users/qa/.local/share/com.taomni.app.qa/localstorage/state-wal"
    ));
    assert!(event_path_allowed(
        &roots,
        &ignored,
        "/users/qa/.local/share/another-app/notes.txt"
    ));
    assert!(event_path_allowed(
        &roots,
        &ignored,
        "/users/qa/.local/share/com.taomni.app.qa-other/notes.txt"
    ));
    assert!(event_path_allowed(
        &roots,
        &ignored,
        "/users/qa/Documents/notes.txt"
    ));
    assert!(!event_path_allowed(
        &roots,
        &ignored,
        "/users/qa-other/Documents/notes.txt"
    ));
}

#[test]
fn explicit_application_folder_and_loose_file_remain_observable() {
    let ignored = vec!["/users/qa/.local/share/com.taomni.app.qa".into()];
    for (recursive, path) in [
        (true, "/users/qa/.local/share/com.taomni.app.qa"),
        (
            false,
            "/users/qa/.local/share/com.taomni.app.qa/settings.json",
        ),
    ] {
        let roots = [WorkspaceWatchTarget {
            recursive,
            direct_children: false,
            filter_path: path.into(),
        }];
        assert!(event_path_allowed(
            &roots,
            &ignored,
            "/users/qa/.local/share/com.taomni.app.qa/settings.json"
        ));
        assert!(!event_path_allowed(
            &roots,
            &ignored,
            "/users/qa/Documents/notes.txt"
        ));
    }
}

#[test]
fn explicit_application_file_does_not_enable_unrelated_private_state_events() {
    let ignored = vec!["/users/qa/.local/share/com.taomni.app.qa".into()];
    let targets = [
        WorkspaceWatchTarget {
            recursive: true,
            direct_children: false,
            filter_path: "/users/qa".into(),
        },
        WorkspaceWatchTarget {
            recursive: false,
            direct_children: false,
            filter_path: "/users/qa/.local/share/com.taomni.app.qa/settings.json".into(),
        },
    ];
    assert!(event_path_allowed(
        &targets,
        &ignored,
        "/users/qa/.local/share/com.taomni.app.qa/settings.json"
    ));
    assert!(!event_path_allowed(
        &targets,
        &ignored,
        "/users/qa/.local/share/com.taomni.app.qa/localstorage/state-wal"
    ));
}

#[tokio::test]
async fn real_watcher_discards_internal_writes_but_delivers_external_files() {
    let root = tempfile::tempdir().unwrap();
    let internal = root.path().join(".local/share/com.taomni.app.qa");
    let documents = root.path().join("Documents");
    std::fs::create_dir_all(&internal).unwrap();
    std::fs::create_dir_all(&documents).unwrap();
    let root_path = root.path().to_string_lossy().into_owned();
    let ignored = internal.clone();
    let mut registered = tokio::task::spawn_blocking(move || {
        register(
            vec![root_path],
            vec![],
            vec![ignored],
            CancellationToken::new(),
        )
    })
    .await
    .unwrap()
    .unwrap();
    std::fs::write(internal.join("localstorage-wal"), "private state").unwrap();
    let external = documents.join("notes.txt");
    std::fs::write(&external, "external text").unwrap();
    let expected = watcher::normalized_file_operation_path(&external);
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let event = registered.events.recv().await.unwrap().unwrap();
            let changes = watcher::notify_event_changes(&event);
            assert!(
                changes
                    .iter()
                    .all(|change| !change.path.contains("localstorage-wal"))
            );
            if changes.iter().any(|change| change.path == expected) {
                break;
            }
        }
    })
    .await
    .expect("real external modification must reach the watcher queue");
}

#[test]
fn cancelled_registration_never_creates_a_live_watcher() {
    let root = tempfile::tempdir().unwrap();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let result = register(
        vec![root.path().to_string_lossy().into_owned()],
        vec![],
        vec![],
        cancelled,
    );
    assert!(result.err().unwrap().contains("cancelled"));
}

#[tokio::test]
async fn overlapping_starts_and_stop_cannot_republish_a_stale_watcher() {
    let root = tempfile::tempdir().unwrap();
    let manager = LspManager::new();
    let path = root.path().to_string_lossy().into_owned();
    let (old, latest) = tokio::join!(
        manager.start_workspace_watcher("same", vec![path.clone()]),
        manager.start_workspace_watcher("same", vec![path]),
    );
    assert!(old.is_ok() || old.unwrap_err().contains("cancelled"));
    latest.expect("latest watcher initializes");
    assert_eq!(manager.workspace_watchers.lock().await.len(), 1);
    manager.stop_workspace_watcher("same").await;
    tokio::task::yield_now().await;
    assert!(manager.workspace_watchers.lock().await.is_empty());
}

#[tokio::test]
async fn home_watch_is_shallow_with_explicit_loaded_directories_and_open_files() {
    let root = tempfile::tempdir().unwrap();
    let documents = root.path().join("Documents");
    let closed = root.path().join("closed");
    std::fs::create_dir_all(&documents).unwrap();
    std::fs::create_dir_all(&closed).unwrap();
    let loose = closed.join("open.txt");
    std::fs::write(&loose, "before").unwrap();
    let home = root.path().to_path_buf();
    let roots = vec![
        home.to_string_lossy().into_owned(),
        loose.to_string_lossy().into_owned(),
    ];
    let dirs = vec![documents.to_string_lossy().into_owned()];
    let mut registered = tokio::task::spawn_blocking(move || {
        register_with_home(roots, dirs, vec![], Some(home), CancellationToken::new())
    })
    .await
    .unwrap()
    .unwrap();
    assert!(registered.targets.iter().all(|target| !target.recursive));
    let hidden = watcher::normalized_file_operation_path(&closed.join("hidden.txt"));
    assert!(!event_path_allowed(&registered.targets, &[], &hidden));
    // The open file remains observable after deletion and recreation even
    // though its parent is not expanded in the explorer.
    std::fs::remove_file(&loose).unwrap();
    std::fs::write(&loose, "after").unwrap();
    std::fs::write(documents.join("added.txt"), "visible").unwrap();
    let open_path = watcher::normalized_file_operation_path(&loose);
    let mut saw_open = false;
    let mut saw_directory = false;
    tokio::time::timeout(Duration::from_secs(4), async {
        while !saw_open || !saw_directory {
            let event = registered.events.recv().await.unwrap().unwrap();
            for change in watcher::notify_event_changes(&event) {
                saw_open |= change.path == open_path && change.change_type != 3;
                saw_directory |= change.path.ends_with("/Documents/added.txt");
            }
        }
    })
    .await
    .expect("loaded directory and recreated open file remain watched");
}
