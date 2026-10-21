use super::*;
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
