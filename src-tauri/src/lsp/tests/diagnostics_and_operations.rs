use super::*;
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
