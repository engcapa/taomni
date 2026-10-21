use super::*;

#[tauri::command]
pub async fn lsp_prepare_rename(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspPrepareRenameResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .workspace
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspPrepareRenameResult {
                status,
                range: None,
                placeholder: None,
                allowed: false,
                message: Some("Language server is not active".into()),
            });
        }
    };
    let result = session
        .request(
            "textDocument/prepareRename",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
            }),
        )
        .await;
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    match result {
        Ok(Value::Null) | Err(_) => Ok(LspPrepareRenameResult {
            status,
            range: None,
            placeholder: None,
            allowed: false,
            message: Some("Rename is not available at this position".into()),
        }),
        Ok(value) => {
            // Range | { range, placeholder } | { defaultBehavior: true }
            if value.get("defaultBehavior").and_then(Value::as_bool) == Some(true) {
                return Ok(LspPrepareRenameResult {
                    status,
                    range: None,
                    placeholder: None,
                    allowed: true,
                    message: None,
                });
            }
            let range = value
                .get("range")
                .and_then(parse_range)
                .or_else(|| parse_range(&value));
            let placeholder = value
                .get("placeholder")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let allowed = range.is_some() || placeholder.is_some();
            Ok(LspPrepareRenameResult {
                status,
                range,
                placeholder,
                allowed,
                message: None,
            })
        }
    }
}

#[tauri::command]
pub async fn lsp_rename(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    new_name: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspRenameResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .workspace
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspRenameResult {
                status,
                edit: LspWorkspaceEdit::default(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/rename",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "newName": new_name,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspRenameResult {
        status,
        edit: parse_workspace_edit(&result),
    })
}

#[tauri::command]
pub async fn lsp_code_actions(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    diagnostics: Option<Vec<Value>>,
    only: Option<Vec<String>>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCodeActionsResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .workspace
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspCodeActionsResult {
                status,
                actions: Vec::new(),
            });
        }
    };
    let context = code_action_context(diagnostics.unwrap_or_default(), only);
    let actions = code_actions_from_response(
        session
            .request(
                "textDocument/codeAction",
                json!({
                    "textDocument": { "uri": document.uri },
                    "range": {
                        "start": { "line": start_line, "character": start_character },
                        "end": { "line": end_line, "character": end_character },
                    },
                    "context": context,
                }),
            )
            .await,
    )?;
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspCodeActionsResult { status, actions })
}

/// Resolve a lazily populated CodeAction only after the user selects it.
/// Servers are allowed to return just `title`/`data` from codeAction and fill
/// in the edit or command during `codeAction/resolve`; merge the response with
/// the original object so omitted fields remain available to the client.
#[tauri::command]
pub async fn lsp_code_action_resolve(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    action: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCodeActionResolveResult, String> {
    if !action.is_object() {
        return Err("codeAction/resolve requires an object action".into());
    }
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .workspace
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspCodeActionResolveResult {
                status,
                action: parse_code_action(&action),
            });
        }
    };
    let timeout_secs = match action.get("kind").and_then(Value::as_str) {
        Some(kind) if kind == "refactor" || kind.starts_with("refactor.") => {
            REFACTOR_RESOLVE_TIMEOUT_SECS
        }
        _ => REQUEST_TIMEOUT_SECS,
    };
    let resolved = session
        .request_with_timeout("codeAction/resolve", action.clone(), timeout_secs)
        .await?;
    let merged = if resolved.is_null() {
        action
    } else {
        merge_code_action_values(&action, &resolved)
    };
    let parsed = parse_code_action(&merged)
        .ok_or_else(|| "codeAction/resolve returned an invalid CodeAction".to_string())?;
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspCodeActionResolveResult {
        status,
        action: Some(parsed),
    })
}

#[tauri::command]
pub async fn lsp_formatting(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    tab_size: Option<u32>,
    insert_spaces: Option<bool>,
) -> Result<LspFormattingResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .workspace
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspFormattingResult {
                status,
                edits: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/formatting",
            json!({
                "textDocument": { "uri": document.uri },
                "options": {
                    "tabSize": tab_size.unwrap_or(2),
                    "insertSpaces": insert_spaces.unwrap_or(true),
                },
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspFormattingResult {
        status,
        edits: parse_text_edits(&result),
    })
}

#[tauri::command]
pub async fn lsp_range_formatting(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    tab_size: Option<u32>,
    insert_spaces: Option<bool>,
) -> Result<LspFormattingResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .workspace
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspFormattingResult {
                status,
                edits: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/rangeFormatting",
            json!({
                "textDocument": { "uri": document.uri },
                "range": {
                    "start": { "line": start_line, "character": start_character },
                    "end": { "line": end_line, "character": end_character },
                },
                "options": {
                    "tabSize": tab_size.unwrap_or(2),
                    "insertSpaces": insert_spaces.unwrap_or(true),
                },
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspFormattingResult {
        status,
        edits: parse_text_edits(&result),
    })
}
