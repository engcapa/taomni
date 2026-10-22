use super::*;
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
