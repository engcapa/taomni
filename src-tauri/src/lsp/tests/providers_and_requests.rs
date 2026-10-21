use super::*;
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
