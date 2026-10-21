use super::*;
use serde_json::json;

/// Serializes tests that mutate the process-global jdtls vmargs / java settings
/// (both feed `jdtls_vmargs()`), so parallel runs do not clobber each other.
static JAVA_GLOBALS_LOCK: StdMutex<()> = StdMutex::new(());

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

#[test]
fn workspace_diagnostic_provider_supports_static_and_dynamic_registration() {
    let static_capabilities = json!({
        "diagnosticProvider": {
            "identifier": "typescript",
            "workspaceDiagnostics": true
        }
    });
    assert_eq!(
        workspace_diagnostic_provider_options(&static_capabilities, &[]).unwrap()["identifier"],
        json!("typescript")
    );
    assert!(
        workspace_diagnostic_provider_options(
            &json!({ "diagnosticProvider": { "workspaceDiagnostics": false } }),
            &[]
        )
        .is_none()
    );

    let registrations = vec![DynamicCapabilityRegistration {
        id: "pull".into(),
        method: "workspace/diagnostic".into(),
        register_options: json!({ "identifier": "dynamic" }),
    }];
    assert_eq!(
        workspace_diagnostic_provider_options(&Value::Null, &registrations).unwrap()["identifier"],
        json!("dynamic")
    );
}

#[test]
fn workspace_diagnostic_reports_apply_full_unchanged_and_related_documents_atomically() {
    let main_uri = "file:///repo/src/main.rs";
    let unchanged_uri = "file:///repo/src/lib.rs";
    let related_uri = "file:///repo/Cargo.toml";
    let old = LspDiagnostic {
        range: LspRange {
            start: LspPosition {
                line: 0,
                character: 0,
            },
            end: LspPosition {
                line: 0,
                character: 1,
            },
        },
        severity: Some(2),
        code: None,
        code_description: None,
        source: Some("old".into()),
        message: "keep".into(),
        tags: Vec::new(),
        related_information: Vec::new(),
        data: None,
    };
    let mut diagnostics = HashMap::from([(unchanged_uri.to_string(), vec![old])]);
    let mut result_ids = HashMap::from([
        (main_uri.to_string(), "old-main".to_string()),
        (unchanged_uri.to_string(), "old-lib".to_string()),
    ]);
    let response = json!({
        "items": [
            {
                "uri": main_uri,
                "kind": "full",
                "resultId": "main-2",
                "items": [{
                    "range": {
                        "start": { "line": 2, "character": 3 },
                        "end": { "line": 2, "character": 7 }
                    },
                    "severity": 1,
                    "source": "rustc",
                    "message": "broken"
                }]
            },
            {
                "uri": unchanged_uri,
                "kind": "unchanged",
                "resultId": "lib-2"
            }
        ],
        "relatedDocuments": {
            (related_uri): {
                "kind": "full",
                "resultId": "cargo-1",
                "items": []
            }
        }
    });

    apply_workspace_diagnostic_report(&response, &mut diagnostics, &mut result_ids).unwrap();
    assert_eq!(diagnostics[main_uri][0].message, "broken");
    assert_eq!(diagnostics[unchanged_uri][0].message, "keep");
    assert!(diagnostics[related_uri].is_empty());
    assert_eq!(result_ids[main_uri], "main-2");
    assert_eq!(result_ids[unchanged_uri], "lib-2");
    assert_eq!(result_ids[related_uri], "cargo-1");

    let before_diagnostics = diagnostics.clone();
    let before_result_ids = result_ids.clone();
    assert!(
        apply_workspace_diagnostic_report(
            &json!({
                "items": [
                    { "uri": main_uri, "kind": "full", "items": [] },
                    { "uri": unchanged_uri, "kind": "invalid" }
                ]
            }),
            &mut diagnostics,
            &mut result_ids,
        )
        .is_err()
    );
    assert_eq!(diagnostics.len(), before_diagnostics.len());
    assert_eq!(
        diagnostics[main_uri][0].message,
        before_diagnostics[main_uri][0].message
    );
    assert_eq!(result_ids, before_result_ids);
}

#[test]
fn workspace_diagnostic_partial_items_precede_final_items() {
    let response = merge_workspace_diagnostic_partial_results(
        json!({
            "items": [{
                "uri": "file:///repo/src/final.rs",
                "kind": "full",
                "items": []
            }]
        }),
        vec![
            json!({
                "uri": "file:///repo/src/first.rs",
                "kind": "full",
                "items": []
            }),
            json!({
                "uri": "file:///repo/src/second.rs",
                "kind": "unchanged",
                "resultId": "second-1"
            }),
        ],
    )
    .unwrap();
    let uris = response["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["uri"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        uris,
        vec![
            "file:///repo/src/first.rs",
            "file:///repo/src/second.rs",
            "file:///repo/src/final.rs"
        ]
    );
    assert!(
        merge_workspace_diagnostic_partial_results(
            json!({ "kind": "full" }),
            vec![json!({ "uri": "file:///repo/a" })]
        )
        .is_err()
    );
}

#[test]
fn file_operation_filters_merge_static_and_dynamic_capabilities() {
    let server_capabilities = json!({
        "workspace": {
            "fileOperations": {
                "willRename": {
                    "filters": [{ "scheme": "file", "pattern": { "glob": "**/*.rs" } }]
                }
            }
        }
    });
    let registrations = vec![DynamicCapabilityRegistration {
        id: "rename-files".into(),
        method: "workspace/willRenameFiles".into(),
        register_options: json!({
            "filters": [{ "scheme": "file", "pattern": { "glob": "**/*.toml" } }]
        }),
    }];

    let filters = file_operation_filters_from(
        &server_capabilities,
        &registrations,
        "workspace/willRenameFiles",
    )
    .expect("rename support");
    assert_eq!(filters.len(), 2);
    assert_eq!(filters[0]["pattern"]["glob"], json!("**/*.rs"));
    assert_eq!(filters[1]["pattern"]["glob"], json!("**/*.toml"));
    assert!(
        file_operation_filters_from(
            &server_capabilities,
            &registrations,
            "workspace/willCreateFiles"
        )
        .is_none()
    );
}

#[test]
fn file_operation_filters_honor_root_glob_kind_scheme_and_case() {
    let root = tempfile::tempdir().unwrap();
    let root_uri = url::Url::from_directory_path(root.path())
        .unwrap()
        .to_string();
    let source_uri = url::Url::from_file_path(root.path().join("src/Main.JAVA"))
        .unwrap()
        .to_string();
    let outside = tempfile::tempdir().unwrap();
    let outside_uri = url::Url::from_file_path(outside.path().join("Main.JAVA"))
        .unwrap()
        .to_string();
    let file_filter = json!({
        "scheme": "file",
        "pattern": {
            "glob": "**/*.java",
            "matches": "file",
            "options": { "ignoreCase": true }
        }
    });

    assert!(file_operation_filter_matches(
        &file_filter,
        &root_uri,
        &source_uri,
        false
    ));
    assert!(!file_operation_filter_matches(
        &file_filter,
        &root_uri,
        &source_uri,
        true
    ));
    assert!(!file_operation_filter_matches(
        &file_filter,
        &root_uri,
        &outside_uri,
        false
    ));
    assert!(!file_operation_filter_matches(
        &json!({
            "scheme": "untitled",
            "pattern": { "glob": "**/*" }
        }),
        &root_uri,
        &source_uri,
        false
    ));
}

#[test]
fn workspace_file_operation_params_filter_batches_and_preserve_rename_uris() {
    let root = tempfile::tempdir().unwrap();
    let root_uri = url::Url::from_directory_path(root.path())
        .unwrap()
        .to_string();
    let old_path = root.path().join("src/Main.java");
    let new_path = root.path().join("src/Main.kt");
    let ignored_old_path = root.path().join("README.md");
    let ignored_new_path = root.path().join("README.txt");
    let operation = LspWorkspaceFileOperation::Rename {
        files: vec![
            LspWorkspaceFileRenameTarget {
                old_path: old_path.to_string_lossy().into_owned(),
                new_path: new_path.to_string_lossy().into_owned(),
                is_directory: false,
            },
            LspWorkspaceFileRenameTarget {
                old_path: ignored_old_path.to_string_lossy().into_owned(),
                new_path: ignored_new_path.to_string_lossy().into_owned(),
                is_directory: false,
            },
        ],
    };
    let filters = vec![json!({
        "scheme": "file",
        "pattern": { "glob": "**/*.java", "matches": "file" }
    })];

    let params = workspace_file_operation_params(&root_uri, &operation, &filters)
        .unwrap()
        .expect("one matching rename");
    assert_eq!(params["files"].as_array().unwrap().len(), 1);
    assert_eq!(
        params["files"][0]["oldUri"],
        json!(url::Url::from_file_path(old_path).unwrap().to_string())
    );
    assert_eq!(
        params["files"][0]["newUri"],
        json!(url::Url::from_file_path(new_path).unwrap().to_string())
    );
}

#[test]
fn deserializes_workspace_file_operation_camel_case_contract() {
    let operation: LspWorkspaceFileOperation = serde_json::from_value(json!({
        "kind": "rename",
        "files": [{
            "oldPath": "/repo/src/Old.java",
            "newPath": "/repo/src/New.java",
            "isDirectory": false
        }]
    }))
    .unwrap();

    assert_eq!(operation.will_method(), "workspace/willRenameFiles");
    assert_eq!(operation.did_method(), "workspace/didRenameFiles");
    match operation {
        LspWorkspaceFileOperation::Rename { files } => {
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].old_path, "/repo/src/Old.java");
            assert_eq!(files[0].new_path, "/repo/src/New.java");
            assert!(!files[0].is_directory);
        }
        _ => panic!("expected rename operation"),
    }
}

#[test]
fn jdtls_initialization_uses_project_java_runtimes() {
    let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
    let mut environment = WorkspaceSdkEnvironment::passthrough(&root, &root);
    environment.java_runtimes = vec![JavaRuntimeConfiguration {
        name: "JavaSE-17".to_string(),
        path: "/sdk/jdk-17".to_string(),
        default: true,
    }];

    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_configured_java_settings(None);
    let java = find_preset("java").expect("java preset");
    let options = lsp_initialization_options(&java, &java.commands[0], &environment);

    assert_eq!(
        options["settings"]["java"]["configuration"]["runtimes"][0],
        json!({ "name": "JavaSE-17", "path": "/sdk/jdk-17", "default": true })
    );
    // Required for jdt:// definitions into the JDK and dependency JARs.
    assert_eq!(
        options["extendedClientCapabilities"]["classFileContentsSupport"],
        json!(true)
    );
    // Default settings widen jdtls beyond bare runtimes (M6-A): autobuild on,
    // completion + format + import + code generation present.
    assert_eq!(
        options["settings"]["java"]["autobuild"]["enabled"],
        json!(true)
    );
    assert_eq!(
        options["settings"]["java"]["completion"]["guessMethodArguments"],
        json!(true)
    );
    assert!(
        options["settings"]["java"]["completion"]["favoriteStaticMembers"]
            .as_array()
            .is_some_and(|members| members
                .iter()
                .any(|m| m == "org.junit.jupiter.api.Assertions.*")),
        "JUnit 5 assertions should be a favorite static member by default"
    );
    assert_eq!(
        options["settings"]["java"]["saveActions"]["organizeImports"],
        json!(false)
    );
    let rust = find_preset("rust").expect("rust preset");
    assert_eq!(
        lsp_initialization_options(&rust, &rust.commands[0], &environment),
        Value::Null
    );
}

#[test]
fn metals_initialization_enables_virtual_documents() {
    let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
    let environment = WorkspaceSdkEnvironment::passthrough(&root, &root);
    let scala = find_preset("scala").expect("scala preset");
    assert_eq!(
        lsp_initialization_options(&scala, &scala.commands[0], &environment),
        json!({ "isVirtualDocumentSupported": true })
    );
}

#[test]
fn java_settings_default_and_round_trip() {
    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_configured_java_settings(None);
    let defaults = get_configured_java_settings();
    assert!(defaults.autobuild_enabled);
    assert!(!defaults.lombok_enabled);
    assert!(!defaults.save_actions_organize_imports);

    // A partial JSON payload from the frontend fills omitted fields from Default.
    let partial: JavaLanguageSettings = serde_json::from_value(json!({
        "lombokEnabled": true,
        "saveActionsOrganizeImports": true
    }))
    .expect("partial settings deserialize");
    assert!(partial.lombok_enabled);
    assert!(partial.save_actions_organize_imports);
    // Untouched fields keep their defaults.
    assert!(partial.autobuild_enabled);
    assert!(partial.guess_method_arguments);

    set_configured_java_settings(Some(partial.clone()));
    assert_eq!(get_configured_java_settings(), partial);
    set_configured_java_settings(None);
}

#[test]
fn lombok_javaagent_only_when_enabled_with_jar() {
    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_configured_java_settings(None);
    assert!(lombok_javaagent_arg().is_none());

    set_configured_java_settings(Some(JavaLanguageSettings {
        lombok_enabled: true,
        lombok_jar_path: Some("  ".into()),
        ..Default::default()
    }));
    assert!(
        lombok_javaagent_arg().is_none(),
        "blank jar path must not produce a -javaagent"
    );

    let jar = if cfg!(windows) {
        r"C:\tools\lombok.jar"
    } else {
        "/opt/lombok.jar"
    };
    set_configured_java_settings(Some(JavaLanguageSettings {
        lombok_enabled: true,
        lombok_jar_path: Some(jar.into()),
        ..Default::default()
    }));
    assert_eq!(lombok_javaagent_arg(), Some(format!("-javaagent:{jar}")));
    assert!(
        jdtls_vmargs()
            .iter()
            .any(|arg| arg == &format!("-javaagent:{jar}")),
        "vmargs should carry the Lombok agent so both launch paths pick it up"
    );
    set_configured_java_settings(None);
}

#[test]
fn file_path_from_uri_maps_file_and_skips_virtual() {
    let (uri, expected_suffix) = if cfg!(windows) {
        ("file:///C:/repo/src/Main.java", "Main.java")
    } else {
        ("file:///repo/src/Main.java", "Main.java")
    };
    let path = file_path_from_uri(uri).expect("file uri maps to a path");
    assert!(path.ends_with(expected_suffix), "got {path}");
    // Virtual / non-file URIs are skipped (library sources must not clutter Problems).
    assert!(file_path_from_uri("jdt://contents/java.base/java.lang/String.class?=x").is_none());
    assert!(file_path_from_uri("not a uri").is_none());
}

#[test]
fn parses_java_modules_from_project_uris() {
    let (root_a, root_b) = if cfg!(windows) {
        ("file:///C:/repo/app", "file:///C:/repo/lib")
    } else {
        ("file:///repo/app", "file:///repo/lib")
    };
    // Out of order + a duplicate + a non-file URI that must be skipped.
    let value = json!([root_b, root_a, root_b, "jdt://contents/foo"]);
    let modules = parse_java_modules(&value);
    assert_eq!(modules.len(), 2, "dedup + skip non-file, got {modules:?}");
    // Sorted by name: app before lib.
    assert_eq!(modules[0].name, "app");
    assert_eq!(modules[1].name, "lib");
    assert_eq!(modules[0].uri, root_a);
    assert!(modules[0].path.ends_with("app"));

    assert!(parse_java_modules(&json!(null)).is_empty());
    assert!(parse_java_modules(&json!([])).is_empty());
}

#[test]
fn hot_update_settings_omit_runtimes() {
    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_configured_java_settings(None);
    // A live didChangeConfiguration push must not send an empty runtimes array
    // (that would clobber the JDK config jdtls resolved at initialize).
    let java = get_configured_java_settings().to_java_settings(&[]);
    assert!(
        java["configuration"].get("runtimes").is_none(),
        "empty runtimes must be omitted, got: {java:#}"
    );
    assert_eq!(
        java["configuration"]["updateBuildConfiguration"],
        json!("interactive")
    );

    // Whereas initialize carries them.
    let with_runtimes =
        get_configured_java_settings().to_java_settings(&[JavaRuntimeConfiguration {
            name: "JavaSE-21".into(),
            path: "/sdk/jdk-21".into(),
            default: true,
        }]);
    assert_eq!(
        with_runtimes["configuration"]["runtimes"][0]["name"],
        json!("JavaSE-21")
    );
}

#[test]
fn session_key_changes_with_sdk_fingerprint_and_project_scope() {
    let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
    let document = ResolvedDocument {
        path: root.join("module/src/Main.kt"),
        uri: "file:///repo/module/src/Main.kt".to_string(),
        root_path: root.clone(),
        workspace_id: "workspace".to_string(),
        preset: find_preset("kotlin"),
        language_id: Some("kotlin".to_string()),
        version: 1,
    };
    let preset = document.preset.as_ref().expect("kotlin preset");
    let command = &preset.commands[0];
    let mut first = WorkspaceSdkEnvironment::passthrough(&root, &root);
    first.project_scope_path = root.join("module").to_string_lossy().into_owned();
    first.fingerprint = "jdk-17".to_string();
    let mut second = first.clone();
    second.fingerprint = "jdk-21".to_string();

    let first_key = session_key(&document, preset, command, &first);
    let second_key = session_key(&document, preset, command, &second);

    assert_ne!(first_key.map_key(), second_key.map_key());
    assert_eq!(first_key.root_path, first.project_scope_path);
}

#[test]
fn lsp_session_root_is_a_noop_without_symlinks() {
    // A plain (already-canonical) root that equals the scope is returned as-is.
    let root = std::env::temp_dir().join(format!("taomni_ra_plain_{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let canonical = std::fs::canonicalize(&root).unwrap();
    let scope = canonical.to_string_lossy().into_owned();

    let session_root = lsp_session_root(&canonical, &scope);
    assert_eq!(session_root, canonical);

    std::fs::remove_dir_all(&root).ok();
}

// The regression: the workspace is opened through a symlink, but the SDK
// resolver canonicalizes the scope. The launch root must stay in the opened
// (symlink) namespace so it shares a path prefix with the document URIs the
// frontend sends — otherwise rust-analyzer treats every file as detached and
// serves no intelligence while the session still reports "active".
#[cfg(unix)]
#[test]
fn lsp_session_root_stays_in_opened_symlink_namespace() {
    let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    let unique = format!("taomni_ra_symlink_{}", std::process::id());
    let real = base.join(format!("{unique}_real"));
    let link = base.join(format!("{unique}_link"));
    std::fs::create_dir_all(&real).unwrap();
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&real, &link).unwrap();

    // What the SDK resolver produces: the canonicalized real path.
    let scope = std::fs::canonicalize(&link)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(scope, real.to_string_lossy());

    // Opened via the symlink → launch root must be the symlink path, not `real`,
    // so it prefixes `file://<link>/src/main.rs`.
    let session_root = lsp_session_root(&link, &scope);
    assert_eq!(session_root, link);
    assert_ne!(session_root, real);

    std::fs::remove_file(&link).ok();
    std::fs::remove_dir_all(&real).ok();
}

// A nested SDK subproject scope (e.g. a Java module) under a symlinked root
// must be rebased onto the opened path, preserving the nesting while keeping
// the opened namespace.
#[cfg(unix)]
#[test]
fn lsp_session_root_rebases_nested_scope_onto_symlink() {
    let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    let unique = format!("taomni_ra_nested_{}", std::process::id());
    let real = base.join(format!("{unique}_real"));
    let link = base.join(format!("{unique}_link"));
    std::fs::create_dir_all(real.join("module")).unwrap();
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&real, &link).unwrap();

    // Scope points at the canonical nested module.
    let scope = std::fs::canonicalize(link.join("module"))
        .unwrap()
        .to_string_lossy()
        .into_owned();

    let session_root = lsp_session_root(&link, &scope);
    assert_eq!(session_root, link.join("module"));

    std::fs::remove_file(&link).ok();
    std::fs::remove_dir_all(&real).ok();
}

#[test]
fn kotlin_prefers_official_lsp_and_keeps_community_fallback() {
    let kotlin = find_preset("kotlin").expect("kotlin preset");
    assert_eq!(kotlin.commands[0].id, "kotlin-lsp");
    assert!(!kotlin.commands[0].fallback);
    assert_eq!(kotlin.commands[1].id, "kotlin-language-server");
    assert!(kotlin.commands[1].fallback);
}

#[test]
fn parses_java_major_versions_from_minus_version_output() {
    assert_eq!(
        parse_java_major_from_version_output(
            r#"openjdk version "21.0.2" 2024-01-16
OpenJDK Runtime Environment (build 21.0.2+13)
"#
        ),
        Some(21)
    );
    assert_eq!(
        parse_java_major_from_version_output(
            r#"java version "17.0.4" 2022-07-19 LTS
Java(TM) SE Runtime Environment (build 17.0.4+11-LTS-179)
"#
        ),
        Some(17)
    );
    assert_eq!(
        parse_java_major_from_version_output(r#"java version "1.8.0_392""#),
        Some(8)
    );
    assert_eq!(JDTLS_MIN_JAVA_MAJOR, 21);
}

#[test]
fn jdtls_runtime_probe_labels_insufficient_java_message() {
    // Shape of the error string used to derive Settings runtimeStatus.
    let err = format!(
        "jdtls requires Java {JDTLS_MIN_JAVA_MAJOR}+ (current Eclipse JDT LS); found Java 17 at C:\\\\jdk-17\\\\bin\\\\java.exe"
    );
    let major = err
        .split("found Java ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|s| s.parse::<u32>().ok());
    assert_eq!(major, Some(17));
    let java = find_preset("java").expect("java preset");
    assert!(preset_uses_jdtls(&java, java.commands.first()));
    assert!(command_is_jdtls(&java.commands[0]));
}

#[test]
fn resolve_java_binary_from_user_path_accepts_home_or_binary_shape() {
    let temp = std::env::temp_dir().join(format!("taomni-jdtls-java-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    let bin_dir = temp.join("bin");
    std::fs::create_dir_all(&bin_dir).expect("mkdir");
    let bin_name = if cfg!(windows) { "java.exe" } else { "java" };
    let java_bin = bin_dir.join(bin_name);
    std::fs::write(&java_bin, b"stub").expect("write stub java");

    assert_eq!(
        resolve_java_binary_from_user_path(&temp),
        Some(java_bin.clone())
    );
    assert_eq!(
        resolve_java_binary_from_user_path(&bin_dir),
        Some(java_bin.clone())
    );
    assert_eq!(
        resolve_java_binary_from_user_path(&java_bin),
        Some(java_bin.clone())
    );
    assert_eq!(
        java_home_from_binary(&java_bin).as_deref(),
        Some(temp.as_path())
    );

    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn configured_java_home_round_trips_and_rejects_missing_path() {
    set_configured_java_home(None);
    assert!(get_configured_java_home().is_none());

    let missing = PathBuf::from("/definitely/missing/jdk-for-taomni-test");
    set_configured_java_home(Some(missing.to_string_lossy().as_ref()));
    assert_eq!(get_configured_java_home(), Some(missing.clone()));
    let err = resolve_java_for_jdtls().expect_err("missing configured path must fail");
    assert!(
        err.contains("invalid") || err.contains("not found") || err.contains("configured"),
        "unexpected error: {err}"
    );

    set_configured_java_home(None);
    assert!(get_configured_java_home().is_none());
}

#[test]
fn configured_java_vmargs_defaults_and_round_trips() {
    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Lombok can append a -javaagent to jdtls_vmargs(); keep it off here so the
    // vec assertion below sees only the configured args.
    set_configured_java_settings(None);
    set_configured_java_vmargs(None);
    assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);
    assert!(get_configured_java_vmargs().is_none());

    set_configured_java_vmargs(Some("   "));
    assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);

    set_configured_java_vmargs(Some("-Xmx2G -XX:+UseG1GC -Dfoo=bar"));
    assert_eq!(jdtls_vmargs_string(), "-Xmx2G -XX:+UseG1GC -Dfoo=bar");
    assert_eq!(
        jdtls_vmargs(),
        vec![
            "-Xmx2G".to_string(),
            "-XX:+UseG1GC".to_string(),
            "-Dfoo=bar".to_string(),
        ]
    );

    set_configured_java_vmargs(None);
    assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);
}

#[test]
fn split_jvm_args_honors_quotes() {
    let args = split_jvm_args(r#"-Xmx2G -Dpath="/opt/my jdk" -Dname='a b'"#);
    assert_eq!(
        args,
        vec![
            "-Xmx2G".to_string(),
            "-Dpath=/opt/my jdk".to_string(),
            "-Dname=a b".to_string(),
        ]
    );
}

#[test]
fn build_lsp_server_command_keeps_program_on_unix_like() {
    // On every platform the non-batch path must still invoke the program name.
    // Windows batch routing is covered by platform integration; here we only
    // assert the builder returns a Command without panicking for a plain binary.
    let root = PathBuf::from("/tmp/workspace");
    let _cmd = build_lsp_server_command("rust-analyzer", &["--version".into()], &root, None, None)
        .expect("command builder");
}

#[test]
fn maps_jdtls_build_workspace_status_ordinals() {
    // JDT LS answers `java/buildWorkspace` with a BuildWorkspaceStatus ordinal.
    assert_eq!(build_status_from_result(&json!(0)), LspBuildStatus::Failed);
    assert_eq!(build_status_from_result(&json!(1)), LspBuildStatus::Succeed);
    assert_eq!(
        build_status_from_result(&json!(2)),
        LspBuildStatus::WithError
    );
    assert_eq!(
        build_status_from_result(&json!(3)),
        LspBuildStatus::Cancelled
    );
    // Unknown / absent payloads must not block a launch.
    assert_eq!(
        build_status_from_result(&Value::Null),
        LspBuildStatus::Succeed
    );
    assert_eq!(
        build_status_from_result(&json!("done")),
        LspBuildStatus::Succeed
    );
}

#[test]
fn java_project_commands_get_a_longer_budget_than_interactive_requests() {
    // resolveMainClass / resolveClasspath / startDebugSession search the whole
    // project and activate an OSGi bundle on first use; the interactive budget
    // cuts them off mid-flight and the Debug button then looks like a no-op.
    assert!(JAVA_COMMAND_TIMEOUT_SECS > REQUEST_TIMEOUT_SECS);
    assert!(BUILD_WORKSPACE_TIMEOUT_SECS > JAVA_COMMAND_TIMEOUT_SECS);
}

#[test]
fn server_configuration_sections_are_resolved_without_silent_nulls() {
    let configuration = json!({
        "java": { "autobuild": { "enabled": true } },
        "editor": { "tabSize": 2 }
    });
    assert_eq!(
        configuration_section_value(&configuration, Some("java.autobuild")),
        json!({ "enabled": true })
    );
    assert_eq!(
        configuration_section_value(&configuration, Some("missing")),
        Value::Null
    );
    assert_eq!(
        configuration_section_value(&configuration, None),
        configuration
    );
}

#[test]
fn server_message_requests_preserve_action_payloads_and_validate_indices() {
    let parsed = parse_show_message_request(Some(&json!({
        "type": 2,
        "message": "Choose",
        "actions": [{ "title": "Keep", "command": "keep" }, { "title": "Drop" }]
    })))
    .expect("valid message request");
    assert_eq!(parsed.message_type, 2);
    assert_eq!(parsed.actions[0]["command"], "keep");
    assert!(
        parse_show_message_request(Some(&json!({
            "type": 2,
            "message": "Choose",
            "actions": [{ "label": "missing title" }]
        })))
        .is_none()
    );
}

#[test]
fn jdtls_service_ready_status_is_distinct_from_initialize() {
    assert!(language_status_is_service_ready(Some(&json!({
        "type": "ServiceReady",
        "message": "ServiceReady"
    }))));
    assert!(!language_status_is_service_ready(Some(&json!({
        "type": "Started"
    }))));
    assert!(!language_status_is_service_ready(Some(&json!({
        "message": "ServiceReady"
    }))));
    assert!(!language_status_is_service_ready(None));
}

#[test]
fn progress_tokens_are_type_sensitive_and_percentages_are_bounded() {
    assert_ne!(
        progress_token_key(&json!(1)),
        progress_token_key(&json!("1"))
    );
    assert_eq!(
        progress_percentage(&json!({ "percentage": 120 })),
        Some(100)
    );
    assert_eq!(progress_percentage(&json!({ "percentage": 42 })), Some(42));
    assert!(is_progress_token(&json!("build")));
    assert!(!is_progress_token(&Value::Null));
}

#[test]
fn unknown_server_request_uses_standard_json_rpc_method_not_found_code() {
    assert_eq!(JSON_RPC_METHOD_NOT_FOUND, -32601);
    assert_eq!(LSP_REQUEST_CANCELLED, -32800);
}

#[test]
fn detects_fernflower_decompiler_banner() {
    let decompiled =
        format!("{JDTLS_DECOMPILER_HEADER} (from Intellij IDEA).\npackage java.lang;\n");
    assert!(is_decompiled_contents(&decompiled));
    // Leading blank lines still count (jdtls hands us the banner verbatim).
    assert!(is_decompiled_contents(&format!("\n{decompiled}")));
    assert!(!is_decompiled_contents(
        "package java.lang;\npublic class String {}\n"
    ));
    assert!(!is_decompiled_contents(""));
}

#[test]
fn jdtls_data_dir_is_stable_per_project_and_distinct_across_projects() {
    let a1 = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\a" } else { "/a" }));
    let a2 = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\a" } else { "/a" }));
    let b = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\b" } else { "/b" }));
    assert_eq!(a1, a2, "same project must reuse its index dir");
    assert_ne!(a1, b, "different projects must not share an index dir");
    assert!(a1.starts_with(jdtls_data_root()));
}

#[test]
fn prune_removes_only_indexes_whose_project_is_gone() {
    let base = std::env::temp_dir().join(format!("taomni-jdtls-prune-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let live_project = base.join("live-project");
    std::fs::create_dir_all(&live_project).unwrap();

    // Stand-ins for two index dirs: one for a live project, one for a deleted one.
    let live_index = base.join("index-live");
    let gone_index = base.join("index-gone");
    let no_marker = base.join("index-nomarker");
    for dir in [&live_index, &gone_index, &no_marker] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(
        live_index.join(JDTLS_WORKSPACE_MARKER),
        live_project.to_string_lossy().as_bytes(),
    )
    .unwrap();
    std::fs::write(
        gone_index.join(JDTLS_WORKSPACE_MARKER),
        base.join("deleted-project").to_string_lossy().as_bytes(),
    )
    .unwrap();

    // Exercise the same predicate prune uses, scoped to this temp tree.
    for entry in std::fs::read_dir(&base).unwrap().flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(project) = std::fs::read_to_string(dir.join(JDTLS_WORKSPACE_MARKER)) else {
            continue;
        };
        let project = project.trim();
        if !project.is_empty() && !Path::new(project).exists() {
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }

    assert!(live_index.is_dir(), "index of a live project must be kept");
    assert!(
        !gone_index.is_dir(),
        "index of a deleted project must be pruned"
    );
    assert!(no_marker.is_dir(), "unmarked dirs are left untouched");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn ensure_jdtls_data_dir_creates_dir_and_marker() {
    let base = std::env::temp_dir().join(format!("taomni-jdtls-ensure-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let data_dir = base.join("index");
    let workspace = base.join("proj");
    ensure_jdtls_data_dir(&data_dir, &workspace).unwrap();
    assert!(data_dir.is_dir());
    let marker = std::fs::read_to_string(data_dir.join(JDTLS_WORKSPACE_MARKER)).unwrap();
    assert_eq!(marker, workspace.to_string_lossy());
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn is_jdtls_program_detects_wrapper_names() {
    assert!(is_jdtls_program("jdtls", Path::new("jdtls")));
    assert!(is_jdtls_program(
        r"C:\Users\me\AppData\Local\jdtls-bin\jdtls.cmd",
        Path::new(r"C:\Users\me\AppData\Local\jdtls-bin\jdtls.cmd")
    ));
    assert!(!is_jdtls_program(
        "rust-analyzer",
        Path::new("rust-analyzer")
    ));
}

#[test]
fn windows_cmd_line_quotes_paths_with_spaces() {
    #[cfg(windows)]
    {
        let line = windows_cmd_line(
            Path::new(r"C:\Program Files\tools\server.cmd"),
            &["--stdio".into()],
        );
        assert_eq!(line, r#""C:\Program Files\tools\server.cmd" --stdio"#);
    }
    #[cfg(not(windows))]
    {
        // windows_cmd_line is Windows-only; keep the test compiling.
        assert!(true);
    }
}

#[test]
fn clangd_install_hint_mentions_package_or_path() {
    let hint = install_hint_for("clangd");
    assert!(
        hint.contains("clangd") || hint.contains("llvm") || hint.contains("LLVM"),
        "unexpected clangd hint: {hint}"
    );
}

#[tokio::test]
async fn coalesces_concurrent_session_start_claims() {
    let manager = LspManager::new();
    let start = match manager
        .claim_session("workspace\nrust\n/root\nrust-analyzer", "workspace")
        .await
    {
        LspSessionClaim::Start(start) => start,
        _ => panic!("first claimant must own the session start"),
    };
    let waiter = match manager
        .claim_session("workspace\nrust\n/root\nrust-analyzer", "workspace")
        .await
    {
        LspSessionClaim::Wait(waiter) => waiter,
        _ => panic!("concurrent claimant must wait for the in-flight start"),
    };

    assert!(Arc::ptr_eq(&start, &waiter));
}

#[tokio::test]
async fn broadcasts_start_failure_and_allows_retry() {
    let manager = LspManager::new();
    let key = "workspace\nrust\n/root\nrust-analyzer";
    let start = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Start(start) => start,
        _ => panic!("first claimant must own the session start"),
    };
    let waiter = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Wait(waiter) => waiter,
        _ => panic!("concurrent claimant must wait for the in-flight start"),
    };

    let _ = manager
        .finish_session_start(key, &start, Err("initialize failed".into()))
        .await;
    match waiter.wait().await {
        Err(error) => assert_eq!(error, "initialize failed"),
        Ok(_) => panic!("waiter must receive the shared initialization failure"),
    }
    assert!(matches!(
        manager.claim_session(key, "workspace").await,
        LspSessionClaim::Start(_)
    ));
}

#[tokio::test]
async fn stopping_workspace_cancels_start_waiters_and_clears_slot() {
    let manager = LspManager::new();
    let key = "workspace\nrust\n/root\nrust-analyzer";
    let start = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Start(start) => start,
        _ => panic!("first claimant must own the session start"),
    };
    let waiter = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Wait(waiter) => waiter,
        _ => panic!("concurrent claimant must wait for the in-flight start"),
    };
    assert!(Arc::ptr_eq(&start, &waiter));

    assert_eq!(manager.stop_workspace("workspace").await, 1);
    match waiter.wait().await {
        Err(error) => assert!(error.contains("workspace stopped")),
        Ok(_) => panic!("workspace shutdown must cancel an in-flight start"),
    }
    assert!(matches!(
        manager.claim_session(key, "workspace").await,
        LspSessionClaim::Start(_)
    ));
}

#[test]
fn flattens_hierarchical_document_symbols_with_depth() {
    let response = json!([
        {
            "name": "OpenFileState",
            "detail": "",
            "kind": 11,
            "range": { "start": { "line": 4, "character": 0 }, "end": { "line": 8, "character": 1 } },
            "selectionRange": { "start": { "line": 4, "character": 10 }, "end": { "line": 4, "character": 23 } },
            "children": [
                {
                    "name": "path",
                    "detail": "string",
                    "kind": 7,
                    "range": { "start": { "line": 5, "character": 2 }, "end": { "line": 5, "character": 15 } },
                    "selectionRange": { "start": { "line": 5, "character": 2 }, "end": { "line": 5, "character": 6 } }
                }
            ]
        }
    ]);

    let mut symbols = Vec::new();
    collect_document_symbols(&response, 0, &mut symbols);

    assert_eq!(symbols.len(), 2);
    assert_eq!(symbols[0].name, "OpenFileState");
    assert_eq!(symbols[0].depth, 0);
    assert_eq!(symbols[0].detail, None);
    assert_eq!(symbols[0].selection_range.start.character, 10);
    assert_eq!(symbols[1].name, "path");
    assert_eq!(symbols[1].depth, 1);
    assert_eq!(symbols[1].detail.as_deref(), Some("string"));
}

#[test]
fn code_actions_from_response_propagates_errors() {
    let timeout = code_actions_from_response(Err(
        "language server request timed out: textDocument/codeAction".into(),
    ));
    assert_eq!(
        timeout.err().as_deref(),
        Some("language server request timed out: textDocument/codeAction")
    );
    let cancelled = code_actions_from_response(Err(
        "language server request cancelled: document changed".into(),
    ));
    assert_eq!(
        cancelled.err().as_deref(),
        Some("language server request cancelled: document changed")
    );
}

#[test]
fn code_actions_from_response_keeps_null_as_empty() {
    let actions = code_actions_from_response(Ok(Value::Null)).expect("null is valid");
    assert!(actions.is_empty());
    let empty = code_actions_from_response(Ok(json!([]))).expect("empty array is valid");
    assert!(empty.is_empty());
}

#[test]
fn code_actions_from_response_parses_actions() {
    let response = json!([
        {
            "title": "Extract to method",
            "kind": "refactor.extract.function",
            "isPreferred": true,
            "data": { "extractMethod": true }
        }
    ]);
    let actions = code_actions_from_response(Ok(response)).expect("actions");
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].title, "Extract to method");
    assert_eq!(
        actions[0].kind.as_deref(),
        Some("refactor.extract.function")
    );
    assert!(actions[0].is_preferred);
    assert_eq!(
        actions[0]
            .raw
            .get("data")
            .and_then(|data| data.get("extractMethod"))
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn accepts_flat_symbol_information_responses() {
    let response = json!([
        {
            "name": "workspace_read_file",
            "kind": 12,
            "containerName": "workspace",
            "location": {
                "uri": "file:///repo/src/workspace.rs",
                "range": { "start": { "line": 3, "character": 0 }, "end": { "line": 12, "character": 1 } }
            }
        },
        { "name": "missing range" }
    ]);

    let mut symbols = Vec::new();
    collect_document_symbols(&response, 0, &mut symbols);

    assert_eq!(symbols.len(), 1);
    assert_eq!(symbols[0].name, "workspace_read_file");
    assert_eq!(symbols[0].kind, 12);
    assert_eq!(symbols[0].detail.as_deref(), Some("workspace"));
    assert_eq!(symbols[0].selection_range.start.line, 3);
}

#[test]
fn ignores_null_and_non_array_responses() {
    let mut symbols = Vec::new();
    collect_document_symbols(&Value::Null, 0, &mut symbols);
    collect_document_symbols(&json!({ "unexpected": true }), 0, &mut symbols);
    assert!(symbols.is_empty());
}

#[test]
fn summarizes_server_capabilities_across_provider_shapes() {
    let summary = capability_summary_from(&json!({
        "completionProvider": { "triggerCharacters": [".", "::"], "resolveProvider": true },
        "signatureHelpProvider": { "triggerCharacters": ["(", ","] },
        "hoverProvider": true,
        "declarationProvider": true,
        "workspaceSymbolProvider": { "resolveProvider": true },
        "renameProvider": { "prepareProvider": true },
        "selectionRangeProvider": true,
        "documentFormattingProvider": false,
        "typeHierarchyProvider": null,
    }));

    assert!(summary.completion);
    assert_eq!(summary.completion_trigger_characters, vec![".", "::"]);
    assert!(summary.signature_help);
    assert_eq!(summary.signature_trigger_characters, vec!["(", ","]);
    assert!(summary.hover);
    assert!(summary.declaration);
    assert!(summary.rename);
    assert!(summary.selection_range);
    assert!(!summary.formatting);
    assert!(!summary.type_hierarchy);
    assert!(summary.workspace_symbol);
    assert!(summary.workspace_symbol_resolve);
}

#[test]
fn dynamic_workspace_symbol_capability_tracks_resolve_provider() {
    let registration = DynamicCapabilityRegistration {
        id: "workspace-symbols".into(),
        method: "workspace/symbol".into(),
        register_options: json!({ "resolveProvider": true }),
    };
    let (summary, _, _, _) = capability_state_from(&json!({}), &[registration]);

    assert!(summary.workspace_symbol);
    assert!(summary.workspace_symbol_resolve);
}

#[test]
fn parses_diagnostic_metadata_and_bounds_provider_data() {
    let related = json!({
        "location": {
            "uri": "file:///repo/src/sink.ts",
            "range": { "start": { "line": 2, "character": 1 }, "end": { "line": 2, "character": 4 } }
        },
        "message": "value reaches sink"
    });
    let value = json!({
        "range": { "start": { "line": 1, "character": 0 }, "end": { "line": 1, "character": 2 } },
        "severity": 2,
        "code": 6133,
        "source": "typescript",
        "message": "unused",
        "tags": [1, 2, 9],
        "relatedInformation": [related],
        "codeDescription": { "href": "https://example.test/6133" },
        "data": { "rule": "unused" }
    });
    let parsed = parse_diagnostic(&value).expect("diagnostic");
    assert_eq!(parsed.code.as_deref(), Some("6133"));
    assert_eq!(parsed.tags, vec![1, 2]);
    assert_eq!(parsed.related_information.len(), 1);
    assert_eq!(
        parsed.code_description.as_deref(),
        Some("https://example.test/6133")
    );
    assert_eq!(parsed.data, Some(json!({ "rule": "unused" })));

    let oversized = json!({ "payload": "x".repeat(64 * 1024) });
    assert!(bounded_diagnostic_data(&oversized).is_none());
}

#[test]
fn store_diagnostics_reports_only_real_changes() {
    let uri = "file:///repo/src/main/java/com/example/single/QuickFixTarget.java";
    let diagnostic = LspDiagnostic {
        range: LspRange {
            start: LspPosition {
                line: 12,
                character: 28,
            },
            end: LspPosition {
                line: 12,
                character: 39,
            },
        },
        severity: Some(1),
        code: Some("16777218".into()),
        source: Some("java".into()),
        message: "StringUtils cannot be resolved".into(),
        tags: Vec::new(),
        related_information: Vec::new(),
        code_description: None,
        data: None,
    };
    let mut stored: HashMap<String, Vec<LspDiagnostic>> = HashMap::new();

    // First publish for the document (empty -> report) must signal.
    assert!(store_diagnostics(
        &mut stored,
        uri,
        vec![diagnostic.clone()]
    ));

    // Servers republish the identical report after every reconcile; the
    // frontend must not be re-signalled for those.
    assert!(!store_diagnostics(
        &mut stored,
        uri,
        vec![diagnostic.clone()]
    ));

    // A changed report (message edit) must signal again.
    let mut edited = diagnostic.clone();
    edited.message = "StringUtils cannot be resolved to a type".into();
    assert!(store_diagnostics(&mut stored, uri, vec![edited.clone()]));

    // Republishing the edited report is again silent.
    assert!(!store_diagnostics(&mut stored, uri, vec![edited.clone()]));

    // Clearing the report (problems fixed) must signal.
    assert!(store_diagnostics(&mut stored, uri, Vec::new()));

    // Republishing the empty report is silent.
    assert!(!store_diagnostics(&mut stored, uri, Vec::new()));

    // A different document's publish is independent.
    assert!(store_diagnostics(
        &mut stored,
        "file:///repo/src/Other.java",
        vec![diagnostic]
    ));
    assert_eq!(stored[uri], Vec::<LspDiagnostic>::new());
    assert_eq!(stored["file:///repo/src/Other.java"].len(), 1);
}

#[test]
fn code_action_context_omits_empty_only_and_trims_kinds() {
    let without_only = code_action_context(vec![], Some(vec![" ".into(), "".into()]));
    assert!(without_only.get("only").is_none());
    let with_only = code_action_context(
        vec![],
        Some(vec![" refactor.extract ".into(), "quickfix".into()]),
    );
    assert_eq!(with_only["only"], json!(["refactor.extract", "quickfix"]));
    assert_eq!(with_only["triggerKind"], json!(1));
}

#[test]
fn dynamic_capabilities_register_and_unregister_independently() {
    let base = json!({ "hoverProvider": true });
    let params = json!({
        "registrations": [
            {
                "id": "completion-one",
                "method": "textDocument/completion",
                "registerOptions": { "triggerCharacters": ["."] }
            },
            {
                "id": "completion-two",
                "method": "textDocument/completion",
                "registerOptions": { "triggerCharacters": [":"] }
            },
            {
                "id": "semantic",
                "method": "textDocument/semanticTokens",
                "registerOptions": {
                    "legend": { "tokenTypes": ["class"], "tokenModifiers": ["static"] },
                    "full": { "delta": true }
                }
            }
        ]
    });
    let registrations = parse_dynamic_capability_registrations(Some(&params));
    let (summary, token_types, token_modifiers, delta) =
        capability_state_from(&base, &registrations);
    assert!(summary.hover);
    assert!(summary.completion);
    assert_eq!(summary.completion_trigger_characters, vec![".", ":"]);
    assert!(summary.semantic_tokens);
    assert_eq!(token_types, vec!["class"]);
    assert_eq!(token_modifiers, vec!["static"]);
    assert!(delta);

    let unregister = json!({
        "unregisterations": [{ "id": "completion-one", "method": "textDocument/completion" }]
    });
    assert_eq!(
        parse_dynamic_capability_unregistrations(Some(&unregister)),
        vec!["completion-one"]
    );
    let remaining = registrations
        .into_iter()
        .filter(|registration| registration.id != "completion-one")
        .collect::<Vec<_>>();
    let (summary, _, _, _) = capability_state_from(&base, &remaining);
    assert!(summary.completion);
    assert_eq!(summary.completion_trigger_characters, vec![":"]);
}

#[test]
fn dynamic_capability_request_validation_accepts_empty_and_rejects_malformed_entries() {
    let empty = json!({ "registrations": [] });
    assert_eq!(
        parse_dynamic_capability_registrations_checked(Some(&empty)).unwrap(),
        Vec::<DynamicCapabilityRegistration>::new()
    );
    assert!(parse_dynamic_capability_registrations_checked(None).is_err());
    assert!(parse_dynamic_capability_registrations_checked(Some(&json!({}))).is_err());
    assert!(
        parse_dynamic_capability_registrations_checked(Some(&json!({
            "registrations": [{ "id": "", "method": "textDocument/hover" }]
        })))
        .is_err()
    );
    assert!(
        parse_dynamic_capability_registrations_checked(Some(&json!({
            "registrations": [{ "id": "hover", "method": 42 }]
        })))
        .is_err()
    );

    let unregister_empty = json!({ "unregisterations": [] });
    assert_eq!(
        parse_dynamic_capability_unregistrations_checked(Some(&unregister_empty)).unwrap(),
        Vec::<String>::new()
    );
    assert!(
        parse_dynamic_capability_unregistrations_checked(Some(&json!({
            "unregisterations": [{ "id": "" }]
        })))
        .is_err()
    );
}

#[test]
fn reads_text_document_sync_kind_and_falls_back_to_full_changes() {
    assert_eq!(
        text_document_sync_kind(&json!({ "textDocumentSync": 2 })),
        2
    );
    assert_eq!(
        text_document_sync_kind(&json!({ "textDocumentSync": { "change": 2 } })),
        2
    );
    assert_eq!(
        text_document_sync_kind(&json!({ "textDocumentSync": 0 })),
        0
    );
    assert_eq!(text_document_sync_kind(&json!({})), 1);

    let incremental = LspDocumentContentChange {
        range: LspRange {
            start: LspPosition {
                line: 1,
                character: 4,
            },
            end: LspPosition {
                line: 1,
                character: 7,
            },
        },
        range_length: 3,
        text: "replacement".into(),
    };
    assert_eq!(
        content_change_for_sync(Some("full text".into()), Some(incremental.clone()), 2).unwrap(),
        json!({
            "range": {
                "start": { "line": 1, "character": 4 },
                "end": { "line": 1, "character": 7 }
            },
            "rangeLength": 3,
            "text": "replacement"
        })
    );
    assert_eq!(
        content_change_for_sync(Some("full text".into()), Some(incremental), 1).unwrap(),
        json!({ "text": "full text" })
    );
    assert!(content_change_for_sync(None, None, 1).is_err());
}

#[test]
fn associates_and_removes_pending_requests_by_document_uri() {
    let uri = "file:///repo/src/main.rs";
    assert_eq!(
        request_document_uri(&json!({ "textDocument": { "uri": uri } })),
        Some(uri)
    );
    assert_eq!(
        request_document_uri(&json!({ "item": { "uri": uri } })),
        Some(uri)
    );

    let (document_sender, _document_receiver) = oneshot::channel();
    let (workspace_sender, _workspace_receiver) = oneshot::channel();
    let mut pending = HashMap::from([
        (
            1,
            PendingResponse {
                sender: document_sender,
                document_uri: Some(uri.into()),
            },
        ),
        (
            2,
            PendingResponse {
                sender: workspace_sender,
                document_uri: None,
            },
        ),
    ]);

    let cancelled = take_pending_for_document(&mut pending, uri);
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].0, 1);
    assert!(pending.contains_key(&2));
}

#[test]
fn caches_command_availability_until_explicit_refresh() {
    let directory = tempfile::tempdir().unwrap();
    let command_path = directory.path().join("temporary-language-server");
    std::fs::write(&command_path, b"test").unwrap();
    let command = command_path.to_string_lossy().into_owned();
    command_availability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&command);

    assert!(command_available(&command));
    std::fs::remove_file(&command_path).unwrap();
    assert!(command_available(&command));

    command_availability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&command);
    assert!(!command_available(&command));
}

#[test]
fn treats_rust_analyzer_next_to_rustup_as_a_shim() {
    let directory = tempfile::tempdir().unwrap();
    let shim = directory
        .path()
        .join(format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX));
    std::fs::write(&shim, b"test").unwrap();

    // No sibling rustup: a plain binary, taken at face value.
    assert!(!is_rustup_shim(&shim));

    std::fs::write(
        directory
            .path()
            .join(format!("rustup{}", std::env::consts::EXE_SUFFIX)),
        b"test",
    )
    .unwrap();
    assert!(is_rustup_shim(&shim));

    // Other binaries in the same directory are not rustup proxies.
    let other = directory
        .path()
        .join(format!("gopls{}", std::env::consts::EXE_SUFFIX));
    std::fs::write(&other, b"test").unwrap();
    assert!(!is_rustup_shim(&other));
}

#[test]
fn reports_unrunnable_rustup_shim_as_unavailable() {
    let directory = tempfile::tempdir().unwrap();
    // Not a real executable, so `--version` cannot succeed — stands in for a
    // shim whose component was never added.
    let shim = directory
        .path()
        .join(format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX));
    std::fs::write(&shim, b"test").unwrap();
    std::fs::write(
        directory
            .path()
            .join(format!("rustup{}", std::env::consts::EXE_SUFFIX)),
        b"test",
    )
    .unwrap();

    let command = shim.to_string_lossy().into_owned();
    command_availability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&command);
    assert!(!command_available(&command));
}

#[test]
fn parses_completion_lists_and_bare_arrays() {
    let (incomplete, items, truncated_flag) = parse_completion_response(&json!({
        "isIncomplete": true,
        "items": [
            {
                "label": "openFile",
                "kind": 3,
                "detail": "(path: string) => Promise<void>",
                "sortText": "11",
                "insertTextFormat": 2,
                "insertText": "openFile(${1:path})",
                "textEdit": {
                    "newText": "openFile",
                    "insert": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 8 } },
                    "replace": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 10 } }
                },
                "additionalTextEdits": [
                    {
                        "newText": "import { openFile } from \"./files\";\n",
                        "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } }
                    }
                ]
            },
            { "noLabel": true }
        ]
    }));

    assert!(incomplete);
    assert!(!truncated_flag);
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.label, "openFile");
    assert_eq!(item.insert_text_format, Some(2));
    // InsertReplaceEdit prefers the insert range.
    assert_eq!(item.text_edit.as_ref().unwrap().range.end.character, 8);
    assert_eq!(
        item.insert_replace_edit
            .as_ref()
            .unwrap()
            .replace
            .end
            .character,
        10
    );
    assert_eq!(item.additional_text_edits.len(), 1);
    assert!(item.raw.get("label").is_some());

    let (incomplete, items, _) = parse_completion_response(&json!([{ "label": "bare" }]));
    assert!(!incomplete);
    assert_eq!(items[0].label, "bare");

    let (_, empty, _) = parse_completion_response(&Value::Null);
    assert!(empty.is_empty());

    let oversized = json!({
        "isIncomplete": false,
        "items": (0..MAX_COMPLETION_ITEMS + 25)
            .map(|index| json!({ "label": format!("candidate-{index}") }))
            .collect::<Vec<_>>()
    });
    let (incomplete, items, truncated_flag) = parse_completion_response(&oversized);
    assert!(incomplete, "a locally truncated list must remain queryable");
    assert!(truncated_flag, "local truncation must be observable");
    assert_eq!(items.len(), MAX_COMPLETION_ITEMS);
    assert_eq!(items.last().unwrap().label, "candidate-199");
}

#[test]
fn completion_item_preserves_insert_replace_ranges() {
    let item = parse_completion_item(&json!({
            "label": "StringUtils",
            "textEdit": {
                "newText": "StringUtils",
                "insert": { "start": { "line": 4, "character": 8 }, "end": { "line": 4, "character": 17 } },
                "replace": { "start": { "line": 4, "character": 8 }, "end": { "line": 4, "character": 23 } }
            }
        })).unwrap();
    assert_eq!(item.text_edit.as_ref().unwrap().range.end.character, 17);
    assert_eq!(
        item.insert_replace_edit
            .as_ref()
            .unwrap()
            .replace
            .end
            .character,
        23
    );
    let wire = serde_json::to_value(&item).unwrap();
    assert_eq!(wire["insertReplaceEdit"]["replace"]["end"]["character"], 23);
    assert!(parse_completion_item(&json!({
            "label": "bad",
            "textEdit": {
                "newText": "bad",
                "insert": { "start": { "line": 4, "character": 8 }, "end": { "line": 4, "character": 23 } },
                "replace": { "start": { "line": 4, "character": 8 }, "end": { "line": 4, "character": 17 } }
            }
        })).is_none());
}

#[test]
fn completion_resolve_does_not_fallback_on_null_or_error() {
    assert!(matches!(
        classify_completion_resolve_response(Ok(Value::Null)),
        LspCompletionResolveResult::Unavailable { reason } if reason == "resolver-returned-null"
    ));
    assert!(matches!(
        classify_completion_resolve_response(Err("provider rejected".into())),
        LspCompletionResolveResult::Failed { message } if message == "provider rejected"
    ));
    assert!(matches!(
        classify_completion_resolve_response(Err(
            "language server request timed out: completionItem/resolve".into()
        )),
        LspCompletionResolveResult::Timeout
    ));
}

#[test]
fn completion_resolve_supports_static_capability() {
    let registrations = HashMap::new();
    for options in [json!({}), json!({ "resolveProvider": false })] {
        assert!(!completion_provider_supports_resolve(
            &json!({ "completionProvider": options }),
            &registrations
        ));
    }
    assert!(completion_provider_supports_resolve(
        &json!({ "completionProvider": { "resolveProvider": true } }),
        &registrations
    ));
}

#[test]
fn completion_resolve_tracks_dynamic_registration_and_unregistration() {
    let params = json!({
        "registrations": [
            {
                "id": "completion-resolve",
                "method": "textDocument/completion",
                "registerOptions": { "resolveProvider": true }
            },
            {
                "id": "completion-no-resolve",
                "method": "textDocument/completion",
                "registerOptions": { "resolveProvider": false }
            },
            {
                "id": "symbols-resolve",
                "method": "workspace/symbol",
                "registerOptions": { "resolveProvider": true }
            }
        ]
    });
    let mut registrations = parse_dynamic_capability_registrations_checked(Some(&params))
        .unwrap()
        .into_iter()
        .map(|registration| (registration.id.clone(), registration))
        .collect::<HashMap<_, _>>();
    assert!(completion_provider_supports_resolve(
        &json!({}),
        &registrations
    ));
    assert!(completion_provider_supports_resolve(
        &json!({ "completionProvider": { "resolveProvider": false } }),
        &registrations
    ));

    let unregister = json!({
        "unregisterations": [{ "id": "completion-resolve", "method": "textDocument/completion" }]
    });
    for id in parse_dynamic_capability_unregistrations_checked(Some(&unregister)).unwrap() {
        registrations.remove(&id);
    }
    assert!(!completion_provider_supports_resolve(
        &json!({}),
        &registrations
    ));
    assert!(completion_provider_supports_resolve(
        &json!({ "completionProvider": { "resolveProvider": true } }),
        &registrations
    ));
    registrations
        .get_mut("completion-no-resolve")
        .unwrap()
        .register_options = json!({});
    assert!(!completion_provider_supports_resolve(
        &json!({}),
        &registrations
    ));
}

#[test]
fn jdtls_completion_item_resolves_without_advertised_capability() {
    let item = json!({
        "command": {
            "command": "java.completion.onDidSelect",
            "arguments": ["4", "1"]
        },
        "data": { "pid": "1", "rid": "4" }
    });
    assert!(jdtls_completion_item_supports_resolve(&item));

    let unrelated = json!({
        "command": { "command": "some.other.command" },
        "data": { "pid": "1", "rid": "4" }
    });
    assert!(!jdtls_completion_item_supports_resolve(&unrelated));
    assert!(!jdtls_completion_item_supports_resolve(&json!({
        "command": { "command": "java.completion.onDidSelect" }
    })));
}

#[test]
fn parses_signature_help_with_offset_parameter_labels() {
    let (signatures, active_signature, active_parameter) = parse_signature_help(&json!({
        "signatures": [{
            "label": "openFile(path: string, preview: boolean): void",
            "documentation": "Opens a file.",
            "parameters": [
                { "label": "path: string" },
                { "label": [23, 39], "documentation": { "kind": "markdown", "value": "preview flag" } }
            ]
        }],
        "activeSignature": 0,
        "activeParameter": 1
    }));

    assert_eq!(signatures.len(), 1);
    assert_eq!(active_signature, 0);
    assert_eq!(active_parameter, 1);
    let signature = &signatures[0];
    assert_eq!(signature.parameters[0].label, "path: string");
    assert_eq!(signature.parameters[1].label, "preview: boolean");
    assert_eq!(signature.parameters[1].label_start, Some(23));
    assert_eq!(
        signature.parameters[1].documentation.as_deref(),
        Some("preview flag")
    );
}

#[test]
fn parses_formatting_text_edit_arrays() {
    let edits = parse_text_edits(&json!([
        {
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 0, "character": 4 }
            },
            "newText": "  x"
        },
        { "newText": "missing range" },
        {
            "range": {
                "start": { "line": 1, "character": 0 },
                "end": { "line": 1, "character": 0 }
            },
            "newText": "\n"
        }
    ]));
    assert_eq!(edits.len(), 2);
    assert_eq!(edits[0].new_text, "  x");
    assert_eq!(edits[0].range.start.line, 0);
    assert_eq!(edits[1].new_text, "\n");
    assert!(parse_text_edits(&Value::Null).is_empty());
    assert!(parse_text_edits(&json!({ "not": "array" })).is_empty());
}

#[test]
fn parses_workspace_symbol_information() {
    let symbols = parse_workspace_symbols(&json!([
        {
            "name": "CodeWorkspaceTab",
            "kind": 5,
            "containerName": "editor",
            "location": {
                "uri": "file:///repo/src/CodeWorkspaceTab.tsx",
                "range": {
                    "start": { "line": 10, "character": 0 },
                    "end": { "line": 40, "character": 1 }
                }
            }
        },
        { "name": "no location" }
    ]));
    assert_eq!(symbols.len(), 1);
    assert_eq!(symbols[0].name, "CodeWorkspaceTab");
    assert_eq!(symbols[0].kind, 5);
    assert_eq!(symbols[0].container_name.as_deref(), Some("editor"));
    assert_eq!(symbols[0].range.start.line, 10);
    assert!(symbols[0].resolved);
    assert!(symbols[0].resolve_token.is_none());
}

#[test]
fn parses_uri_only_workspace_symbol_as_unresolved() {
    let symbol = parse_workspace_symbol(&json!({
        "name": "DeferredType",
        "kind": 5,
        "location": { "uri": "file:///repo/src/deferred.ts" },
        "data": { "providerHandle": 42 }
    }))
    .expect("URI-only workspace symbol");

    assert!(!symbol.resolved);
    assert_eq!(symbol.range.start.line, 0);
    assert_eq!(symbol.selection_range.start.character, 0);
    assert!(symbol.resolve_token.is_none());
}

#[test]
fn aggregates_workspace_symbols_deterministically_and_deduplicates() {
    let response = |name: &str, path: &str| {
        json!([{
            "name": name,
            "kind": 5,
            "location": {
                "uri": format!("file://{path}"),
                "range": {
                    "start": { "line": 1, "character": 0 },
                    "end": { "line": 1, "character": 3 }
                }
            }
        }])
    };
    let result = aggregate_workspace_symbol_responses(
        vec![
            (
                "TypeScript".into(),
                "typescript-session".into(),
                false,
                Ok(response("B", "/repo/b.ts")),
            ),
            (
                "Java".into(),
                "java-session".into(),
                false,
                Ok(response("A", "/repo/a.java")),
            ),
            (
                "duplicate".into(),
                "duplicate-session".into(),
                false,
                Ok(response("B", "/repo/b.ts")),
            ),
        ],
        3,
        3,
        0,
        false,
    );
    assert!(result.complete);
    assert_eq!(result.symbols.len(), 2);
    assert_eq!(result.symbols[0].name, "A");
    assert_eq!(result.symbols[1].name, "B");
    assert_eq!(result.failed_provider_count, 0);
}

#[test]
fn marks_failed_and_malformed_workspace_symbol_providers_incomplete() {
    let result = aggregate_workspace_symbol_responses(
        vec![
            (
                "broken".into(),
                "broken-session".into(),
                false,
                Err("request timeout".into()),
            ),
            (
                "malformed".into(),
                "malformed-session".into(),
                false,
                Ok(json!([{ "name": "missing location" }])),
            ),
        ],
        2,
        2,
        0,
        false,
    );
    assert!(!result.complete);
    assert_eq!(result.failed_provider_count, 2);
    assert_eq!(result.symbols.len(), 0);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|item| item.contains("timeout"))
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|item| item.contains("malformed"))
    );
}

#[test]
fn marks_missing_providers_and_provider_limit_as_bounded() {
    let result = aggregate_workspace_symbol_responses(
        vec![(
            "TypeScript".into(),
            "typescript-session".into(),
            false,
            Ok(Value::Array(Vec::new())),
        )],
        65,
        1,
        64,
        true,
    );
    assert!(!result.complete);
    assert!(result.truncated);
    assert_eq!(result.skipped_provider_count, 64);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|item| item.contains("limited to"))
    );
}

#[test]
fn reports_no_provider_without_claiming_complete_index() {
    let result = aggregate_workspace_symbol_responses(Vec::new(), 0, 0, 0, false);
    assert!(!result.complete);
    assert!(!result.truncated);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|item| item.contains("No active language server"))
    );
}

#[test]
fn preserves_deferred_symbol_payload_only_for_resolve_provider() {
    let uri_only = json!([{
        "name": "DeferredType",
        "kind": 5,
        "location": { "uri": "file:///repo/src/deferred.ts" },
        "data": { "providerHandle": 42 }
    }]);
    let supported = aggregate_workspace_symbol_responses(
        vec![(
            "TypeScript".into(),
            "typescript-session".into(),
            true,
            Ok(uri_only.clone()),
        )],
        1,
        1,
        0,
        false,
    );
    assert!(supported.complete);
    assert!(!supported.symbols[0].resolved);
    assert_eq!(
        supported.symbols[0].provider_session_key.as_deref(),
        Some("typescript-session")
    );
    assert_eq!(supported.symbols[0].raw.as_ref(), Some(&uri_only[0]));

    let unsupported = aggregate_workspace_symbol_responses(
        vec![(
            "Legacy".into(),
            "legacy-session".into(),
            false,
            Ok(uri_only),
        )],
        1,
        1,
        0,
        false,
    );
    assert!(!unsupported.complete);
    assert_eq!(unsupported.failed_provider_count, 1);
    assert!(unsupported.symbols[0].raw.is_none());
    assert!(
        unsupported
            .diagnostics
            .iter()
            .any(|item| item.contains("without advertising"))
    );
}

#[test]
fn validates_and_merges_workspace_symbol_resolve_payloads() {
    assert_eq!(
        parse_workspace_symbol_resolve_token("0123456789abcdef0123456789abcdef:17"),
        Ok(("0123456789abcdef0123456789abcdef", "17"))
    );
    for invalid in [
        "",
        "short:1",
        "0123456789abcdef0123456789abcdeg:1",
        "0123456789abcdef0123456789abcdef:-1",
    ] {
        assert!(parse_workspace_symbol_resolve_token(invalid).is_err());
    }

    let original = json!({
        "name": "DeferredType",
        "kind": 5,
        "location": { "uri": "file:///repo/src/deferred.ts" },
        "data": { "providerHandle": 42 }
    });
    let response = json!({
        "location": {
            "range": {
                "start": { "line": 8, "character": 2 },
                "end": { "line": 8, "character": 14 }
            }
        }
    });
    let resolved = parse_workspace_symbol(&merge_workspace_symbol_values(&original, &response))
        .expect("resolved symbol");
    assert!(resolved.resolved);
    assert_eq!(resolved.selection_range.start.line, 8);
    assert_eq!(resolved.name, "DeferredType");
}

#[test]
fn newer_workspace_symbol_query_cancels_previous_generation() {
    let mut queries = HashMap::new();
    let first = begin_workspace_symbol_query(&mut queries, "workspace", 1);
    assert!(!first.is_cancelled());

    let second = begin_workspace_symbol_query(&mut queries, "workspace", 2);
    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
    assert_eq!(queries.get("workspace").map(|(id, _)| *id), Some(2));
}

#[tokio::test]
async fn stopping_workspace_cancels_symbol_query_and_clears_resolve_batches() {
    let manager = LspManager::new();
    let cancellation = {
        let mut queries = manager.workspace_symbol_queries.lock().await;
        begin_workspace_symbol_query(&mut queries, "workspace", 1)
    };
    manager.workspace_symbol_resolutions.lock().await.insert(
        "0123456789abcdef0123456789abcdef".into(),
        WorkspaceSymbolResolutionBatch {
            workspace_id: "workspace".into(),
            created_at: Instant::now(),
            bytes: 0,
            entries: HashMap::new(),
        },
    );

    assert_eq!(manager.stop_workspace("workspace").await, 0);
    assert!(cancellation.is_cancelled());
    assert!(manager.workspace_symbol_queries.lock().await.is_empty());
    assert!(manager.workspace_symbol_resolutions.lock().await.is_empty());
}

#[test]
fn parses_code_actions_and_workspace_edits() {
    let actions = parse_code_actions(&json!([
        {
            "title": "Add import",
            "kind": "quickfix",
            "isPreferred": true,
            "edit": {
                "changes": {
                    "file:///repo/src/a.ts": [{
                        "range": {
                            "start": { "line": 0, "character": 0 },
                            "end": { "line": 0, "character": 0 }
                        },
                        "newText": "import x from 'x';\n"
                    }]
                }
            }
        },
        {
            "title": "Organize Imports",
            "command": { "command": "source.organizeImports", "arguments": [] }
        },
        { "noTitle": true }
    ]));
    assert_eq!(actions.len(), 2);
    assert_eq!(actions[0].title, "Add import");
    assert!(actions[0].is_preferred);
    assert_eq!(actions[0].edit.as_ref().unwrap().document_edits.len(), 1);
    assert_eq!(
        actions[1].command.as_deref(),
        Some("source.organizeImports")
    );
}

#[test]
fn code_action_resolve_merges_deferred_fields_with_original_data() {
    let original = json!({
        "title": "Add import",
        "kind": "quickfix",
        "data": { "fixId": 7 }
    });
    let resolved = json!({
        "title": "Add import",
        "edit": {
            "changes": {
                "file:///repo/src/main.ts": [{
                    "range": {
                        "start": { "line": 0, "character": 0 },
                        "end": { "line": 0, "character": 0 }
                    },
                    "newText": "import x;\n"
                }]
            }
        }
    });

    let merged = merge_code_action_values(&original, &resolved);
    assert_eq!(merged["data"]["fixId"], 7);
    let parsed = parse_code_action(&merged).expect("merged CodeAction should parse");
    assert_eq!(parsed.kind.as_deref(), Some("quickfix"));
    assert_eq!(
        parsed.edit.as_ref().map(|edit| edit.document_edits.len()),
        Some(1)
    );
    assert_eq!(parsed.raw["data"]["fixId"], 7);
}

#[test]
fn preserves_workspace_edit_resource_operation_order_and_options() {
    let edit = parse_workspace_edit(&json!({
        "changeAnnotations": {
            "text-1": {
                "label": "Update generated source",
                "needsConfirmation": true,
                "description": "The file is generated"
            },
            "rename-1": { "label": "Rename generated source" }
        },
        "documentChanges": [
            {
                "kind": "create",
                "uri": "file:///repo/src/new.ts",
                "options": { "overwrite": true, "ignoreIfExists": false }
            },
            {
                "textDocument": { "uri": "file:///repo/src/new.ts", "version": 1 },
                "edits": [{
                    "range": {
                        "start": { "line": 0, "character": 0 },
                        "end": { "line": 0, "character": 0 }
                    },
                    "newText": "content",
                    "annotationId": "text-1"
                }]
            },
            {
                "kind": "rename",
                "oldUri": "file:///repo/src/new.ts",
                "newUri": "file:///repo/src/final.ts",
                "annotationId": "rename-1",
                "options": { "ignoreIfExists": true }
            },
            {
                "kind": "delete",
                "uri": "file:///repo/src/final.ts",
                "options": { "recursive": true, "ignoreIfNotExists": true }
            }
        ]
    }));
    assert_eq!(edit.operations.len(), 4);
    assert_eq!(edit.document_edits.len(), 1);
    assert_eq!(edit.change_annotations.len(), 2);
    assert_eq!(edit.change_annotations[1].id, "text-1");
    assert!(edit.change_annotations[1].needs_confirmation);
    assert!(matches!(
        &edit.operations[0],
        LspWorkspaceEditOperation::Create {
            overwrite: true,
            ..
        }
    ));
    assert!(matches!(
        &edit.operations[1],
        LspWorkspaceEditOperation::Text { document }
            if document.edits.len() == 1
                && document.version == Some(1)
                && document.annotation_ids == ["text-1"]
    ));
    assert!(matches!(
        &edit.operations[2],
        LspWorkspaceEditOperation::Rename {
            ignore_if_exists: true,
            annotation_id: Some(annotation_id),
            ..
        } if annotation_id == "rename-1"
    ));
    assert!(matches!(
        &edit.operations[3],
        LspWorkspaceEditOperation::Delete {
            recursive: true,
            ignore_if_not_exists: true,
            ..
        }
    ));
}

#[test]
fn serializes_workspace_edit_and_apply_response_with_camel_case_contract() {
    let edit = LspWorkspaceEdit {
        document_edits: Vec::new(),
        operations: vec![LspWorkspaceEditOperation::Rename {
            old_uri: "file:///repo/old.ts".into(),
            old_path: Some("/repo/old.ts".into()),
            new_uri: "file:///repo/new.ts".into(),
            new_path: Some("/repo/new.ts".into()),
            overwrite: true,
            ignore_if_exists: false,
            annotation_id: Some("rename-1".into()),
        }],
        change_annotations: vec![LspChangeAnnotation {
            id: "rename-1".into(),
            label: "Rename source".into(),
            needs_confirmation: true,
            description: Some("Public API change".into()),
        }],
    };
    let value = serde_json::to_value(edit).unwrap();
    assert_eq!(value["documentEdits"], json!([]));
    assert_eq!(value["operations"][0]["kind"], "rename");
    assert_eq!(value["operations"][0]["oldUri"], "file:///repo/old.ts");
    assert_eq!(value["operations"][0]["newPath"], "/repo/new.ts");
    assert_eq!(value["operations"][0]["ignoreIfExists"], false);
    assert_eq!(value["operations"][0]["annotationId"], "rename-1");
    assert_eq!(value["changeAnnotations"][0]["needsConfirmation"], true);

    let response = serde_json::to_value(LspWorkspaceApplyEditResponse {
        applied: false,
        failure_reason: Some("disk changed".into()),
        failed_change: Some(2),
    })
    .unwrap();
    assert_eq!(
        response,
        json!({
            "applied": false,
            "failureReason": "disk changed",
            "failedChange": 2
        })
    );
}

#[tokio::test]
async fn workspace_apply_edit_bridge_validates_workspace_before_resolving() {
    let bridge = LspClientRequestBridge::new();
    let (sender, receiver) = oneshot::channel();
    bridge.pending_workspace_edits.lock().unwrap().insert(
        "request-1".into(),
        PendingWorkspaceApplyEdit {
            workspace_id: "workspace-a".into(),
            sender,
        },
    );
    let response = LspWorkspaceApplyEditResponse {
        applied: false,
        failure_reason: Some("hash mismatch".into()),
        failed_change: Some(1),
    };

    let mismatch = bridge
        .resolve_workspace_edit("request-1", "workspace-b", response.clone())
        .unwrap_err();
    assert!(mismatch.contains("does not match"));
    assert!(
        bridge
            .pending_workspace_edits
            .lock()
            .unwrap()
            .contains_key("request-1")
    );

    bridge
        .resolve_workspace_edit("request-1", "workspace-a", response.clone())
        .unwrap();
    let received = receiver.await.unwrap();
    assert_eq!(received.applied, response.applied);
    assert_eq!(received.failure_reason, response.failure_reason);
    assert_eq!(received.failed_change, response.failed_change);
    assert!(
        bridge
            .resolve_workspace_edit("request-1", "workspace-a", response)
            .unwrap_err()
            .contains("no pending")
    );
}

#[tokio::test]
async fn workspace_apply_edit_bridge_fails_when_frontend_is_unavailable() {
    let bridge = LspClientRequestBridge::new();
    let response = bridge
        .apply_workspace_edit("workspace-a", None, LspWorkspaceEdit::default())
        .await;
    assert!(!response.applied);
    assert!(
        response
            .failure_reason
            .as_deref()
            .unwrap_or_default()
            .contains("frontend is unavailable")
    );
}

#[tokio::test]
async fn show_message_bridge_validates_workspace_and_action_index() {
    let bridge = LspClientRequestBridge::new();
    let (sender, receiver) = oneshot::channel();
    bridge.pending_show_messages.lock().unwrap().insert(
        "message-1".into(),
        PendingShowMessageRequest {
            workspace_id: "workspace-a".into(),
            actions: vec![json!({ "title": "Keep", "value": 1 })],
            sender,
        },
    );
    assert!(
        bridge
            .resolve_show_message("message-1", "workspace-b", Some(0))
            .unwrap_err()
            .contains("target workspace")
    );
    assert!(
        bridge
            .resolve_show_message("message-1", "workspace-a", Some(3))
            .unwrap_err()
            .contains("out of range")
    );
    bridge
        .resolve_show_message("message-1", "workspace-a", Some(0))
        .unwrap();
    assert_eq!(
        receiver.await.unwrap(),
        Some(json!({ "title": "Keep", "value": 1 }))
    );
}

#[test]
fn parses_hierarchy_items_and_preserves_opaque_data() {
    let items = parse_hierarchy_items(&json!([{
        "name": "renderEditor",
        "detail": "CodeWorkspaceTab",
        "kind": 12,
        "uri": "file:///repo/src/editor.ts",
        "range": {
            "start": { "line": 8, "character": 0 },
            "end": { "line": 20, "character": 1 }
        },
        "selectionRange": {
            "start": { "line": 8, "character": 9 },
            "end": { "line": 8, "character": 21 }
        },
        "data": { "serverId": 42 }
    }]));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].name, "renderEditor");
    assert_eq!(items[0].detail.as_deref(), Some("CodeWorkspaceTab"));
    assert_eq!(items[0].selection_range.start.character, 9);
    assert_eq!(items[0].raw["data"]["serverId"], 42);
}

#[test]
fn parses_incoming_and_outgoing_call_entries() {
    let item = json!({
        "name": "caller",
        "kind": 12,
        "uri": "file:///repo/src/caller.ts",
        "range": {
            "start": { "line": 1, "character": 0 },
            "end": { "line": 4, "character": 1 }
        },
        "selectionRange": {
            "start": { "line": 1, "character": 9 },
            "end": { "line": 1, "character": 15 }
        }
    });
    let range = json!({
        "start": { "line": 3, "character": 2 },
        "end": { "line": 3, "character": 8 }
    });
    let incoming = parse_call_hierarchy_entries(
        &json!([{ "from": item.clone(), "fromRanges": [range.clone()] }]),
        "from",
    );
    let outgoing =
        parse_call_hierarchy_entries(&json!([{ "to": item, "fromRanges": [range] }]), "to");
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0].item.name, "caller");
    assert_eq!(incoming[0].from_ranges[0].start.line, 3);
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0].item.name, "caller");
}

#[test]
fn reference_cancellation_registry_rejects_stale_sequences() {
    let key = format!("__ed_query_001_{:?}", std::thread::current().id());
    let first = begin_reference_request(&key, 1);
    let second = begin_reference_request(&key, 2);

    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
    assert!(!cancel_reference_request(&key, Some(1)));
    assert!(!second.is_cancelled());

    finish_reference_request(Some(&key), Some(1));
    assert!(!second.is_cancelled());
    assert!(cancel_reference_request(&key, Some(2)));
    assert!(second.is_cancelled());
}

#[test]
fn parses_highlights_inlay_hints_and_selection_ranges() {
    let highlights = parse_document_highlights(&json!([
        {
            "range": {
                "start": { "line": 1, "character": 2 },
                "end": { "line": 1, "character": 5 }
            },
            "kind": 3
        },
        { "invalid": true }
    ]));
    assert_eq!(highlights.len(), 1);
    assert_eq!(highlights[0].kind, Some(3));

    let hints = parse_inlay_hints(&json!([
        {
            "position": { "line": 2, "character": 8 },
            "label": [{ "value": "value" }, { "value": ": number" }],
            "kind": 1,
            "tooltip": { "kind": "markdown", "value": "inferred type" },
            "paddingLeft": true
        }
    ]));
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0].label, "value: number");
    assert_eq!(hints[0].tooltip.as_deref(), Some("inferred type"));
    assert!(hints[0].padding_left);

    let ranges = parse_selection_ranges(&json!([{
        "range": {
            "start": { "line": 3, "character": 4 },
            "end": { "line": 3, "character": 8 }
        },
        "parent": {
            "range": {
                "start": { "line": 3, "character": 0 },
                "end": { "line": 3, "character": 10 }
            }
        }
    }]));
    assert_eq!(ranges.len(), 2);
    assert_eq!(ranges[0].start.character, 4);
    assert_eq!(ranges[1].start.character, 0);
}

#[test]
fn parses_semantic_tokens_relative_data() {
    let (types, modifiers) = semantic_token_legend_from(&json!({
        "semanticTokensProvider": {
            "legend": {
                "tokenTypes": ["variable", "function", "class"],
                "tokenModifiers": ["declaration", "readonly"]
            }
        }
    }));
    assert_eq!(types, vec!["variable", "function", "class"]);
    assert_eq!(modifiers, vec!["declaration", "readonly"]);

    // Token A at 0:0 len 3 type variable+declaration
    // Token B same line start+4 len 5 type function
    let tokens = parse_semantic_tokens(
        &json!({ "data": [0, 0, 3, 0, 1, 0, 4, 5, 1, 0] }),
        &types,
        &modifiers,
    );
    assert_eq!(tokens.len(), 2);
    assert_eq!(tokens[0].token_type, "variable");
    assert_eq!(tokens[0].modifiers, vec!["declaration"]);
    assert_eq!(tokens[0].range.start.character, 0);
    assert_eq!(tokens[0].range.end.character, 3);
    assert_eq!(tokens[1].token_type, "function");
    assert_eq!(tokens[1].range.start.character, 4);
    assert_eq!(tokens[1].range.end.character, 9);
}

#[test]
fn applies_semantic_token_delta_edits_and_detects_capability() {
    let capabilities = json!({
        "semanticTokensProvider": {
            "legend": { "tokenTypes": ["variable"], "tokenModifiers": [] },
            "full": { "delta": true }
        }
    });
    assert!(semantic_token_delta_supported(&capabilities));
    let previous = SemanticTokensCache {
        result_id: "one".into(),
        data: vec![0, 0, 3, 0, 0, 0, 4, 2, 0, 0],
    };
    let (data, result_id) = apply_semantic_token_delta(
        &previous,
        &json!({
            "resultId": "two",
            "edits": [{ "start": 5, "deleteCount": 5, "data": [1, 1, 4, 0, 0] }]
        }),
    )
    .unwrap();
    assert_eq!(result_id.as_deref(), Some("two"));
    assert_eq!(data, vec![0, 0, 3, 0, 0, 1, 1, 4, 0, 0]);
    assert!(
        apply_semantic_token_delta(
            &previous,
            &json!({ "edits": [{ "start": 99, "deleteCount": 1 }] }),
        )
        .is_none()
    );
}

#[test]
fn path_from_uri_maps_file_uris_and_rejects_class_uris() {
    #[cfg(windows)]
    {
        let path = path_from_uri("file:///C:/Users/test/Project/Main.java").unwrap();
        assert!(
            path.replace('\\', "/")
                .ends_with("Users/test/Project/Main.java")
        );
    }
    #[cfg(not(windows))]
    {
        assert_eq!(
            path_from_uri("file:///home/test/Project/Main.java").as_deref(),
            Some("/home/test/Project/Main.java")
        );
    }
    assert!(path_from_uri("jdt://contents/java.base/java.lang/String.class?=x").is_none());
    assert!(path_from_uri("jar:file:///lib/foo.jar!/com/Foo.class").is_none());
    assert!(is_virtual_class_uri(
        "jdt://contents/java.base/java.lang/String.class?=x"
    ));
    assert_eq!(
        title_from_class_uri("jdt://contents/java.base/java.lang/String.class?=x"),
        "String.java"
    );
}

#[test]
fn reads_percent_encoded_source_from_archive_uri() {
    use std::io::Write as _;

    let directory = tempfile::tempdir().unwrap();
    let archive_path = directory.path().join("demo sources.jar");
    let file = std::fs::File::create(&archive_path).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    archive
        .start_file(
            "com/acme/Hello World.kt",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    archive
        .write_all(b"package com.acme\nclass HelloWorld\n")
        .unwrap();
    archive.finish().unwrap();

    let file_uri = url::Url::from_file_path(&archive_path).unwrap();
    let uri = format!("jar:{file_uri}!/com/acme/Hello%20World.kt");
    let parsed = archive_document_uri(&uri).expect("archive URI");
    assert_eq!(parsed.archive_path, archive_path);
    assert_eq!(parsed.entry_path, "com/acme/Hello World.kt");

    let contents = read_archive_source_contents(&uri)
        .unwrap()
        .expect("archive source");
    assert_eq!(contents.title, "Hello World.kt");
    assert_eq!(contents.container.as_deref(), Some("demo sources.jar"));
    assert_eq!(contents.language_id, "kotlin");
    assert!(contents.text.contains("class HelloWorld"));
}

#[test]
fn binary_archive_locations_fall_through_to_language_server() {
    let uri = if cfg!(windows) {
        "kls:file:///C:/sdk/kotlin.jar!/kotlin/String.class?source=false"
    } else {
        "kls:file:///sdk/kotlin.jar!/kotlin/String.class?source=false"
    };
    let parsed = archive_document_uri(uri).expect("kls URI");
    assert_eq!(parsed.entry_path, "kotlin/String.class");
    assert!(read_archive_source_contents(uri).unwrap().is_none());
}

#[test]
fn maps_library_source_extensions_to_editor_languages() {
    for (uri, expected) in [
        ("file:///sdk/lib.d.ts", "typescript"),
        ("file:///sdk/lib.mjs", "javascript"),
        ("file:///sdk/types.pyi", "python"),
        ("file:///sdk/runtime.go", "go"),
        ("file:///sdk/System.String.cs", "csharp"),
        ("file:///sdk/UIKit.swiftinterface", "swift"),
        ("file:///sdk/vector.hpp", "cpp"),
    ] {
        assert_eq!(language_id_from_uri(uri), expected, "{uri}");
    }
}

#[test]
fn csharp_ls_preset_enables_metadata_uris() {
    let csharp = find_preset("csharp").expect("csharp preset");
    let server = csharp
        .commands
        .iter()
        .find(|command| command.id == "csharp-ls")
        .expect("csharp-ls command");
    assert_eq!(server.args, ["--features", "metadata-uris"]);
}

#[test]
fn container_from_class_uri_labels_package_and_archive() {
    assert_eq!(
        container_from_class_uri("jdt://contents/java.base/java.lang/String.class?=x").as_deref(),
        Some("java.lang · java.base")
    );
    let jar_class = concat!(
        "jdt://contents/commons-lang3-3.12.0.jar/",
        "org.apache.commons.lang3/StringUtils.class?=y"
    );
    assert_eq!(
        container_from_class_uri(jar_class).as_deref(),
        Some("org.apache.commons.lang3 · commons-lang3-3.12.0.jar")
    );
    assert_eq!(
        container_from_class_uri("jar:file:///libs/foo.jar!/com/acme/Bar.class").as_deref(),
        Some("com.acme · foo.jar")
    );
    assert!(container_from_class_uri("jdt://contents/String.class").is_none());
}

#[test]
fn with_document_uri_overrides_only_when_present() {
    let document = ResolvedDocument {
        path: PathBuf::from(if cfg!(windows) {
            r"C:\repo\src\Main.java"
        } else {
            "/repo/src/Main.java"
        }),
        uri: "file:///repo/src/Main.java".to_string(),
        root_path: PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" }),
        workspace_id: "workspace".to_string(),
        preset: find_preset("java"),
        language_id: Some("java".to_string()),
        version: 0,
    };
    let untouched = with_document_uri(document.clone(), Some("   ".to_string()));
    assert_eq!(untouched.uri, "file:///repo/src/Main.java");
    let library = with_document_uri(
        document,
        Some("jdt://contents/java.base/java.lang/String.class?=x".to_string()),
    );
    assert_eq!(
        library.uri,
        "jdt://contents/java.base/java.lang/String.class?=x"
    );
    // Session / SDK resolution still keys off the origin project file.
    assert!(library.path.ends_with("Main.java"));
}
