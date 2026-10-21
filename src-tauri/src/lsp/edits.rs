use super::*;

pub(super) fn parse_text_edit(value: &Value) -> Option<LspTextEdit> {
    let new_text = value.get("newText")?.as_str()?.to_string();
    // Plain TextEdit carries `range`; InsertReplaceEdit carries
    // `insert`/`replace` ranges — prefer the insert range.
    let range = value
        .get("range")
        .or_else(|| value.get("insert"))
        .or_else(|| value.get("replace"))
        .and_then(parse_range)?;
    Some(LspTextEdit { range, new_text })
}

pub(super) fn parse_completion_insert_replace_edit(value: &Value) -> Option<LspInsertReplaceEdit> {
    if value.get("range").is_some() {
        return None;
    }
    let new_text = value.get("newText")?.as_str()?.to_string();
    let insert = parse_range(value.get("insert")?)?;
    let replace = parse_range(value.get("replace")?)?;
    let position = |p: &LspPosition| (p.line, p.character);
    if insert.start != replace.start
        || position(&insert.start) > position(&insert.end)
        || position(&insert.end) > position(&replace.end)
    {
        return None;
    }
    Some(LspInsertReplaceEdit {
        new_text,
        insert,
        replace,
    })
}

pub(super) fn parse_text_edits(value: &Value) -> Vec<LspTextEdit> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_text_edit).collect())
        .unwrap_or_default()
}

pub(super) fn text_edit_annotation_ids(value: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(edits) = value.as_array() {
        for id in edits
            .iter()
            .filter_map(|edit| edit.get("annotationId").and_then(Value::as_str))
        {
            if !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_string());
            }
        }
    }
    ids
}

pub(super) fn parse_change_annotations(value: &Value) -> Vec<LspChangeAnnotation> {
    let mut annotations = value
        .get("changeAnnotations")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(id, annotation)| {
                    Some(LspChangeAnnotation {
                        id: id.clone(),
                        label: annotation.get("label")?.as_str()?.to_string(),
                        needs_confirmation: annotation
                            .get("needsConfirmation")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        description: annotation
                            .get("description")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    annotations.sort_by(|left, right| left.id.cmp(&right.id));
    annotations
}

pub(super) fn parse_workspace_edit(value: &Value) -> LspWorkspaceEdit {
    let mut document_edits: Vec<LspFileTextEdits> = Vec::new();
    let mut operations: Vec<LspWorkspaceEditOperation> = Vec::new();
    if let Some(changes) = value.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            let document = LspFileTextEdits {
                uri: uri.clone(),
                path: path_from_uri(uri),
                version: None,
                edits: parse_text_edits(edits),
                annotation_ids: text_edit_annotation_ids(edits),
            };
            document_edits.push(document.clone());
            operations.push(LspWorkspaceEditOperation::Text { document });
        }
    }
    if let Some(document_changes) = value.get("documentChanges").and_then(Value::as_array) {
        for change in document_changes {
            let annotation_id = change
                .get("annotationId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let options = change.get("options").unwrap_or(&Value::Null);
            match change.get("kind").and_then(Value::as_str) {
                Some("create") => {
                    let Some(uri) = change.get("uri").and_then(Value::as_str) else {
                        continue;
                    };
                    operations.push(LspWorkspaceEditOperation::Create {
                        uri: uri.to_string(),
                        path: path_from_uri(uri),
                        overwrite: options
                            .get("overwrite")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        ignore_if_exists: options
                            .get("ignoreIfExists")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        annotation_id,
                    });
                }
                Some("rename") => {
                    let Some(old_uri) = change.get("oldUri").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(new_uri) = change.get("newUri").and_then(Value::as_str) else {
                        continue;
                    };
                    operations.push(LspWorkspaceEditOperation::Rename {
                        old_uri: old_uri.to_string(),
                        old_path: path_from_uri(old_uri),
                        new_uri: new_uri.to_string(),
                        new_path: path_from_uri(new_uri),
                        overwrite: options
                            .get("overwrite")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        ignore_if_exists: options
                            .get("ignoreIfExists")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        annotation_id,
                    });
                }
                Some("delete") => {
                    let Some(uri) = change.get("uri").and_then(Value::as_str) else {
                        continue;
                    };
                    operations.push(LspWorkspaceEditOperation::Delete {
                        uri: uri.to_string(),
                        path: path_from_uri(uri),
                        recursive: options
                            .get("recursive")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        ignore_if_not_exists: options
                            .get("ignoreIfNotExists")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        annotation_id,
                    });
                }
                _ => {
                    let Some(uri) = change
                        .get("textDocument")
                        .and_then(|doc| doc.get("uri"))
                        .and_then(Value::as_str)
                    else {
                        continue;
                    };
                    let document = LspFileTextEdits {
                        uri: uri.to_string(),
                        path: path_from_uri(uri),
                        version: change
                            .get("textDocument")
                            .and_then(|document| document.get("version"))
                            .and_then(Value::as_i64),
                        edits: change
                            .get("edits")
                            .map(parse_text_edits)
                            .unwrap_or_default(),
                        annotation_ids: change
                            .get("edits")
                            .map(text_edit_annotation_ids)
                            .unwrap_or_default(),
                    };
                    if let Some(existing) = document_edits
                        .iter_mut()
                        .find(|item| item.uri == document.uri)
                    {
                        existing.edits.extend(document.edits.clone());
                        extend_unique(
                            &mut existing.annotation_ids,
                            document.annotation_ids.clone(),
                        );
                    } else {
                        document_edits.push(document.clone());
                    }
                    operations.push(LspWorkspaceEditOperation::Text { document });
                }
            }
        }
    }
    LspWorkspaceEdit {
        document_edits,
        operations,
        change_annotations: parse_change_annotations(value),
    }
}

pub(super) fn merge_code_action_values(original: &Value, resolved: &Value) -> Value {
    let Some(original_object) = original.as_object() else {
        return resolved.clone();
    };
    let Some(resolved_object) = resolved.as_object() else {
        return original.clone();
    };
    let mut merged = original_object.clone();
    for (key, value) in resolved_object {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

pub(super) fn parse_code_action(value: &Value) -> Option<LspCodeAction> {
    // Command-only entries appear as { title, command, arguments }.
    // Full CodeAction has title + optional edit/command/kind.
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())?
        .to_string();
    let command_name = value.get("command").and_then(|command| {
        if let Some(name) = command.as_str() {
            Some(name.to_string())
        } else {
            command
                .get("command")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }
    });
    let command_arguments = value
        .get("command")
        .and_then(|command| command.get("arguments"))
        .cloned()
        .or_else(|| value.get("arguments").cloned());
    let mut edit = value.get("edit").map(parse_workspace_edit);

    // If edit is missing, but the command is an apply-workspace-edit wrapper (such as
    // JDTLS `_java.apply.workspaceEdit` or `java.apply.workspaceEdit` or VSCode `editor.action.applyWorkspaceEdit`),
    // extract the workspace edit from command_arguments[0].
    let is_apply_workspace_edit_command = command_name.as_deref().is_some_and(|name| {
        name == "_java.apply.workspaceEdit"
            || name == "java.apply.workspaceEdit"
            || name == "editor.action.applyWorkspaceEdit"
            || name == "applyWorkspaceEdit"
    });

    if edit.is_none() && is_apply_workspace_edit_command {
        if let Some(first_arg) = command_arguments
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
        {
            if first_arg.get("changes").is_some() || first_arg.get("documentChanges").is_some() {
                edit = Some(parse_workspace_edit(first_arg));
            }
        }
    }

    let command = if is_apply_workspace_edit_command && edit.is_some() {
        None
    } else {
        command_name
    };

    Some(LspCodeAction {
        title,
        kind: value
            .get("kind")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        is_preferred: value
            .get("isPreferred")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        edit,
        command,
        command_arguments,
        raw: value.clone(),
    })
}

pub(super) fn parse_code_actions(value: &Value) -> Vec<LspCodeAction> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_code_action).collect())
        .unwrap_or_default()
}

/// ED-PARITY-007 DEC-05: keep a provider failure visible instead of collapsing
/// it into an empty action list. `Err` (transport error, 8 s request timeout,
/// "document changed" cancellation) propagates to the caller so the workspace
/// reports the real failure instead of claiming the server offered no actions.
/// A JSON `null` response is a valid empty result, and a missing session
/// remains the caller's `Ok` empty result.
pub(super) fn code_actions_from_response(
    response: Result<Value, String>,
) -> Result<Vec<LspCodeAction>, String> {
    match response {
        Ok(Value::Null) => Ok(Vec::new()),
        Ok(value) => Ok(parse_code_actions(&value)),
        Err(message) => Err(message),
    }
}
