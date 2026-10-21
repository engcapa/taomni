use super::*;
#[test]
fn requested_scope_validation_accepts_only_known_tags() {
    assert!(validate_requested_scope(None).is_ok());
    assert!(validate_requested_scope(Some("default")).is_ok());
    assert!(validate_requested_scope(Some("expanded")).is_ok());
    let error = validate_requested_scope(Some("smart")).unwrap_err();
    assert!(error.contains("invalid requestedScope `smart`"), "{error}");
}

#[test]
fn java_install_hint_is_platform_specific() {
    let hint = install_hint_for("jdtls");
    assert!(
        hint.contains("JDK 21") || hint.contains("jdtls"),
        "expected JDK / jdtls guidance, got: {hint}"
    );
    let java = find_preset("java").expect("java preset");
    assert_eq!(java.commands[0].install_hint, hint);
}

#[test]
fn jdtls_initialize_timeout_is_longer_than_default() {
    let java = find_preset("java").expect("java preset");
    let jdtls = &java.commands[0];
    assert!(
        initialize_timeout_secs(jdtls) >= JDTLS_INITIALIZE_TIMEOUT_SECS,
        "jdtls needs a long initialize window"
    );
    let rust = find_preset("rust").expect("rust preset");
    assert_eq!(
        initialize_timeout_secs(&rust.commands[0]),
        INITIALIZE_TIMEOUT_SECS
    );
}

#[test]
fn workspace_client_capabilities_advertise_supported_edits() {
    let capabilities = workspace_client_capabilities();

    assert_eq!(capabilities["applyEdit"], json!(true));
    assert_eq!(
        capabilities["workspaceEdit"]["documentChanges"],
        json!(true)
    );
    assert_eq!(
        capabilities["workspaceEdit"]["resourceOperations"],
        json!(["create", "rename", "delete"])
    );
    assert_eq!(
        capabilities["workspaceEdit"]["failureHandling"],
        json!("abort")
    );
    assert_eq!(
        capabilities["workspaceEdit"]["changeAnnotationSupport"]["groupsOnLabel"],
        json!(false)
    );
    assert_eq!(capabilities["workspaceFolders"], json!(true));
    assert_eq!(capabilities["configuration"], json!(true));
    assert_eq!(capabilities["diagnostics"]["refreshSupport"], json!(true));
    assert_eq!(
        capabilities["diagnostics"]["relatedDocumentSupport"],
        json!(true)
    );
    assert_eq!(
        capabilities["fileOperations"],
        json!({
            "dynamicRegistration": true,
            "didCreate": true,
            "willCreate": true,
            "didRename": true,
            "willRename": true,
            "didDelete": true,
            "willDelete": true
        })
    );
    assert_eq!(
        capabilities["didChangeWatchedFiles"],
        json!({ "dynamicRegistration": true })
    );
    assert_eq!(capabilities["symbol"]["dynamicRegistration"], json!(true));
    assert_eq!(
        capabilities["symbol"]["resolveSupport"]["properties"],
        json!(["location.range"])
    );
}

#[test]
fn watched_file_globs_honor_kind_root_and_relative_patterns() {
    let root = tempfile::tempdir().unwrap();
    let root_uri = url::Url::from_directory_path(root.path())
        .unwrap()
        .to_string();
    let java_uri = url::Url::from_file_path(root.path().join("src/Main.java"))
        .unwrap()
        .to_string();
    let outside = tempfile::tempdir().unwrap();
    let outside_uri = url::Url::from_file_path(outside.path().join("src/Main.java"))
        .unwrap()
        .to_string();
    let registration = DynamicCapabilityRegistration {
        id: "java-watch".into(),
        method: "workspace/didChangeWatchedFiles".into(),
        register_options: json!({
            "watchers": [{
                "globPattern": "**/*.java",
                "kind": WATCH_KIND_CREATE
            }]
        }),
    };

    assert!(watched_file_registration_matches(
        &registration,
        &root_uri,
        &java_uri,
        WATCH_KIND_CREATE,
    ));
    assert!(!watched_file_registration_matches(
        &registration,
        &root_uri,
        &java_uri,
        WATCH_KIND_CHANGE,
    ));
    assert!(!watched_file_registration_matches(
        &registration,
        &root_uri,
        &outside_uri,
        WATCH_KIND_CREATE,
    ));

    let base = root.path().join("src");
    let base_uri = url::Url::from_directory_path(&base).unwrap().to_string();
    let relative_registration = DynamicCapabilityRegistration {
        id: "kotlin-watch".into(),
        method: "workspace/didChangeWatchedFiles".into(),
        register_options: json!({
            "watchers": [{
                "globPattern": {
                    "baseUri": { "uri": base_uri },
                    "pattern": "**/*.kt"
                }
            }]
        }),
    };
    let kotlin_uri = url::Url::from_file_path(base.join("nested/Main.kt"))
        .unwrap()
        .to_string();
    let wrong_uri = url::Url::from_file_path(root.path().join("Main.kt"))
        .unwrap()
        .to_string();
    assert!(watched_file_registration_matches(
        &relative_registration,
        &root_uri,
        &kotlin_uri,
        WATCH_KIND_CHANGE,
    ));
    assert!(!watched_file_registration_matches(
        &relative_registration,
        &root_uri,
        &wrong_uri,
        WATCH_KIND_CHANGE,
    ));
}

#[test]
fn watched_file_changes_use_lsp_types_and_split_renames() {
    let operation: LspWorkspaceFileOperation = serde_json::from_value(json!({
        "kind": "rename",
        "files": [{
            "oldPath": "/repo/src/Old.java",
            "newPath": "/repo/src/New.java",
            "isDirectory": false
        }]
    }))
    .unwrap();
    assert_eq!(
        operation.watched_file_changes(),
        vec![
            LspWatchedFileChange {
                path: "/repo/src/Old.java".into(),
                change_type: 3,
            },
            LspWatchedFileChange {
                path: "/repo/src/New.java".into(),
                change_type: 1,
            },
        ]
    );
    let changed: LspWatchedFileChange = serde_json::from_value(json!({
        "path": "/repo/src/Main.java",
        "type": 2
    }))
    .unwrap();
    assert_eq!(changed.change_type, 2);
    assert_eq!(
        watch_kind_for_change(changed.change_type),
        Some(WATCH_KIND_CHANGE)
    );
    assert!(watch_kind_for_change(9).is_none());
}

#[test]
fn native_watcher_events_normalize_create_change_delete_and_rename() {
    let root = tempfile::tempdir().unwrap();
    let old_path = root.path().join("Old.java");
    let new_path = root.path().join("New.java");
    let rename = NotifyEvent::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
        .add_path(old_path.clone())
        .add_path(new_path.clone());
    assert_eq!(
        notify_event_changes(&rename),
        vec![
            LspWatchedFileChange {
                path: old_path.to_string_lossy().replace('\\', "/"),
                change_type: 3,
            },
            LspWatchedFileChange {
                path: new_path.to_string_lossy().replace('\\', "/"),
                change_type: 1,
            },
        ]
    );

    let changed = NotifyEvent::new(EventKind::Modify(ModifyKind::Any))
        .add_path(new_path.clone())
        .add_path(new_path.clone());
    assert_eq!(notify_event_changes(&changed).len(), 1);
    assert_eq!(notify_event_changes(&changed)[0].change_type, 2);

    let removed = NotifyEvent::new(EventKind::Remove(notify::event::RemoveKind::File))
        .add_path(new_path.clone());
    assert_eq!(notify_event_changes(&removed)[0].change_type, 3);
}

#[test]
fn native_watcher_directory_changed_events_are_dropped() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("single");
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("SortMembers.java");
    std::fs::write(&file, "class SortMembers {}").unwrap();

    // A directory mtime bump is noise: the file event that caused it
    // arrives separately. Forwarding the directory makes the UI report
    // "File changed on disk: <dir>" and clobbers real statuses.
    let dir_changed = NotifyEvent::new(EventKind::Modify(ModifyKind::Any)).add_path(dir.clone());
    assert!(notify_event_changes(&dir_changed).is_empty());

    // File changes still flow, and directory create/remove are kept so
    // tree structure stays in sync.
    let file_changed = NotifyEvent::new(EventKind::Modify(ModifyKind::Any)).add_path(file.clone());
    assert_eq!(notify_event_changes(&file_changed).len(), 1);
    let dir_created = NotifyEvent::new(EventKind::Create(notify::event::CreateKind::Folder))
        .add_path(dir.clone());
    assert_eq!(notify_event_changes(&dir_created).len(), 1);
    let dir_removed =
        NotifyEvent::new(EventKind::Remove(notify::event::RemoveKind::Folder)).add_path(dir);
    assert_eq!(notify_event_changes(&dir_removed).len(), 1);
}

#[test]
fn workspace_watcher_filters_recursive_roots_and_loose_files() {
    let root = tempfile::tempdir().unwrap();
    let nested = root.path().join("src").join("Main.java");
    let sibling = root.path().join("outside.txt");
    let loose = root.path().join("notes.txt");
    let targets = vec![
        WorkspaceWatchTarget {
            recursive: true,
            filter_path: root.path().to_path_buf(),
        },
        WorkspaceWatchTarget {
            recursive: false,
            filter_path: loose.clone(),
        },
    ];
    assert!(workspace_watch_target_matches(
        &targets,
        &normalized_file_operation_path(&nested)
    ));
    assert!(workspace_watch_target_matches(
        &targets,
        &normalized_file_operation_path(&loose)
    ));
    assert!(workspace_watch_target_matches(
        &[WorkspaceWatchTarget {
            recursive: false,
            filter_path: loose.clone(),
        }],
        &normalized_file_operation_path(&loose)
    ));
    assert!(!workspace_watch_target_matches(
        &[WorkspaceWatchTarget {
            recursive: false,
            filter_path: loose,
        }],
        &normalized_file_operation_path(&sibling)
    ));
}

#[test]
fn local_watcher_suppression_handles_atomic_save_event_variants() {
    let events = StdMutex::new(HashMap::new());
    let now = Instant::now();
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("Main.java");
    std::fs::write(&file, "saved").unwrap();
    let path = normalized_file_operation_path(&file);
    let owned = LocalWatchedEvent {
        at: now,
        snapshot: local_watched_snapshot(&file).unwrap(),
    };
    events
        .lock()
        .unwrap()
        .insert(("workspace".into(), path.clone(), 2), owned.clone());
    assert!(local_watched_event_suppressed(
        &events,
        "workspace",
        &path,
        1,
        now,
    ));
    assert!(!local_watched_event_suppressed(
        &events,
        "workspace",
        &path,
        3,
        now,
    ));

    events
        .lock()
        .unwrap()
        .insert(("workspace".into(), path.clone(), 3), owned);
    assert!(local_watched_event_suppressed(
        &events,
        "workspace",
        &path,
        3,
        now,
    ));
}

#[test]
fn local_watcher_does_not_suppress_external_rewrite_or_delete_after_save() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("README.md");
    std::fs::write(&file, "saved").unwrap();
    let path = normalized_file_operation_path(&file);
    let now = Instant::now();
    let saved = LocalWatchedEvent {
        at: now,
        snapshot: local_watched_snapshot(&file).unwrap(),
    };
    let events = StdMutex::new(HashMap::from([
        (("workspace".into(), path.clone(), 2), saved.clone()),
        (("workspace".into(), path.clone(), 3), saved),
    ]));
    // Equal length must not make an unrelated write look like our save.
    std::fs::write(&file, "other").unwrap();
    assert!(!local_watched_event_suppressed(
        &events,
        "workspace",
        &path,
        2,
        now + Duration::from_millis(1100)
    ));
    std::fs::remove_file(&file).unwrap();
    assert!(!local_watched_event_suppressed(
        &events,
        "workspace",
        &path,
        3,
        now + Duration::from_millis(1200)
    ));

    events.lock().unwrap().insert(
        ("workspace".into(), path.clone(), 3),
        LocalWatchedEvent {
            at: now,
            snapshot: LocalWatchedSnapshot::Missing,
        },
    );
    assert!(local_watched_event_suppressed(
        &events,
        "workspace",
        &path,
        3,
        now + Duration::from_millis(1300)
    ));
}
