use super::*;

#[test]
fn watcher_filters_descendants_relative_to_explicit_roots() {
    for ancestor in [".cache", "target", "build", "node_modules", ".git"] {
        let root = format!("/users/qa/{ancestor}/project");
        let targets = [WorkspaceWatchTarget {
            recursive: true,
            direct_children: false,
            filter_path: PathBuf::from(&root),
        }];
        assert!(watcher::workspace_watch_target_matches(
            &targets,
            &format!("{root}/README.md")
        ));
        assert!(watcher::workspace_watch_target_matches(
            &targets,
            &format!("{root}/src/index.ts")
        ));
        assert!(!watcher::workspace_watch_target_matches(
            &targets,
            &format!("{root}-other/README.md")
        ));
        assert!(!watcher::workspace_watch_target_matches(
            &targets,
            &format!("{root}/node_modules/pkg/index.js")
        ));
        assert!(!watcher::workspace_watch_target_matches(
            &targets,
            &format!("{root}/.cache/result.txt")
        ));
        assert!(!watcher::workspace_watch_target_matches(
            &targets,
            &format!("{root}/.taomni-write-123")
        ));
    }
}

#[test]
fn explicitly_opened_nested_root_and_loose_file_remain_observable() {
    let targets = [
        WorkspaceWatchTarget {
            recursive: true,
            direct_children: false,
            filter_path: PathBuf::from("/repo"),
        },
        WorkspaceWatchTarget {
            recursive: true,
            direct_children: false,
            filter_path: PathBuf::from("/repo/build/project"),
        },
        WorkspaceWatchTarget {
            recursive: false,
            direct_children: false,
            filter_path: PathBuf::from("/notes/.cache/draft.txt"),
        },
    ];
    assert!(watcher::workspace_watch_target_matches(
        &targets,
        "/repo/build/project/README.md"
    ));
    assert!(!watcher::workspace_watch_target_matches(
        &targets,
        "/repo/build/output.bin"
    ));
    assert!(watcher::workspace_watch_target_matches(
        &targets,
        "/notes/.cache/draft.txt"
    ));
    assert!(!watcher::workspace_watch_target_matches(
        &targets,
        "/notes/.cache/sibling.txt"
    ));
}

#[tokio::test]
async fn provider_restart_preserves_real_file_watcher_until_workspace_disposal() {
    let manager = LspManager::new();
    let root = tempfile::tempdir().expect("workspace directory");
    manager
        .start_workspace_watcher(
            "workspace",
            vec![root.path().to_string_lossy().into_owned()],
        )
        .await
        .expect("real OS file watcher");
    let key = "workspace\nrust\n/root\nrust-analyzer";
    let start = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Start(start) => start,
        _ => panic!("first claimant must own the session start"),
    };

    assert_eq!(manager.stop_workspace_servers("workspace").await, 1);
    assert!(
        start.wait().await.is_err(),
        "provider start must be cancelled"
    );
    {
        let watchers = manager.workspace_watchers.lock().await;
        let watcher = watchers
            .get("workspace")
            .expect("explorer still owns watcher");
        assert!(!watcher.task.is_finished());
    }
    std::fs::write(root.path().join("changed.txt"), "external bytes")
        .expect("write while language servers are stopped");

    assert_eq!(manager.stop_workspace("workspace").await, 0);
    assert!(manager.workspace_watchers.lock().await.is_empty());
}

#[tokio::test]
async fn late_cleanup_cannot_cancel_a_replacement_watcher() {
    let manager = LspManager::new();
    let root = tempfile::tempdir().unwrap();
    let roots = vec![root.path().to_string_lossy().into_owned()];
    manager
        .start_workspace_watcher_owned("workspace", roots.clone(), vec![], Some("old".into()))
        .await
        .unwrap();

    // Poll replacement first so its ownership is published before old cleanup
    // runs, while its blocking OS registration is still in flight.
    let replacement = manager.start_workspace_watcher_owned(
        "workspace",
        roots,
        vec![],
        Some("replacement".into()),
    );
    let stale_stop = manager.stop_workspace_watcher_owned("workspace", Some("old"));
    let (result, ()) = tokio::join!(biased; replacement, stale_stop);
    result.expect("old cleanup must not cancel replacement initialization");
    {
        let watchers = manager.workspace_watchers.lock().await;
        let current = watchers
            .get("workspace")
            .expect("replacement remains owned");
        assert_eq!(current.watcher_id.as_deref(), Some("replacement"));
        assert!(!current.cancelled.is_cancelled());
        assert!(!current.task.is_finished());
    }
    manager
        .stop_workspace_watcher_owned("workspace", Some("replacement"))
        .await;
    assert!(manager.workspace_watchers.lock().await.is_empty());
}

#[tokio::test]
async fn owned_cleanup_cancels_its_inflight_registration_and_legacy_disposal_still_works() {
    let manager = LspManager::new();
    let root = tempfile::tempdir().unwrap();
    let roots = vec![root.path().to_string_lossy().into_owned()];
    let start = manager.start_workspace_watcher_owned(
        "workspace",
        roots.clone(),
        vec![],
        Some("disposed".into()),
    );
    let stop = manager.stop_workspace_watcher_owned("workspace", Some("disposed"));
    let (result, ()) = tokio::join!(biased; start, stop);
    if let Err(error) = result {
        assert!(error.contains("cancelled"), "{error}");
    }
    assert!(manager.workspace_watchers.lock().await.is_empty());

    manager
        .start_workspace_watcher_owned("workspace", roots, vec![], Some("mounted".into()))
        .await
        .unwrap();
    manager.stop_workspace_watcher("workspace").await;
    assert!(manager.workspace_watchers.lock().await.is_empty());
}
