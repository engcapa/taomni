use super::*;
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
