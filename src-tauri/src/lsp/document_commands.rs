use super::*;

#[tauri::command]
pub async fn lsp_document_status(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    Ok(state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_execute_command(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    command: String,
    arguments: Vec<Value>,
) -> Result<Value, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| "Language server is not active for this document".to_string())?;
    session
        .request_with_timeout(
            "workspace/executeCommand",
            json!({ "command": command, "arguments": arguments }),
            JAVA_COMMAND_TIMEOUT_SECS,
        )
        .await
}

#[tauri::command]
pub async fn lsp_resolve_workspace_edit(
    state: State<'_, AppState>,
    request_id: String,
    workspace_id: String,
    applied: bool,
    failure_reason: Option<String>,
    failed_change: Option<u32>,
) -> Result<(), String> {
    state.workspace.lsp.client_bridge.resolve_workspace_edit(
        &request_id,
        &workspace_id,
        LspWorkspaceApplyEditResponse {
            applied,
            failure_reason,
            failed_change,
        },
    )
}

#[tauri::command]
pub async fn lsp_resolve_show_message_request(
    state: State<'_, AppState>,
    request_id: String,
    workspace_id: String,
    action_index: Option<u32>,
) -> Result<(), String> {
    state
        .workspace
        .lsp
        .client_bridge
        .resolve_show_message(&request_id, &workspace_id, action_index)
}

#[tauri::command]
pub async fn lsp_cancel_work_done_progress(
    state: State<'_, AppState>,
    workspace_id: String,
    preset_id: String,
    root_uri: String,
    token: Value,
) -> Result<bool, String> {
    state
        .workspace
        .lsp
        .cancel_work_done_progress(&workspace_id, &preset_id, &root_uri, &token)
        .await
}

#[tauri::command]
pub async fn lsp_workspace_will_file_operation(
    state: State<'_, AppState>,
    workspace_id: String,
    operation: LspWorkspaceFileOperation,
) -> Result<usize, String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    state
        .workspace
        .lsp
        .will_workspace_file_operation(workspace_id, &operation)
        .await
}

#[tauri::command]
pub async fn lsp_workspace_did_file_operation(
    state: State<'_, AppState>,
    workspace_id: String,
    operation: LspWorkspaceFileOperation,
) -> Result<usize, String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    Ok(state
        .workspace
        .lsp
        .did_workspace_file_operation(workspace_id, &operation)
        .await)
}

#[tauri::command]
pub async fn lsp_workspace_did_change_watched_files(
    state: State<'_, AppState>,
    workspace_id: String,
    changes: Vec<LspWatchedFileChange>,
) -> Result<usize, String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    for change in &changes {
        if !Path::new(&change.path).is_absolute() {
            return Err(format!(
                "workspace/didChangeWatchedFiles requires an absolute path: {}",
                change.path
            ));
        }
        if watch_kind_for_change(change.change_type).is_none() {
            return Err(format!(
                "workspace/didChangeWatchedFiles has invalid file change type {}",
                change.change_type
            ));
        }
    }
    Ok(state
        .workspace
        .lsp
        .did_change_watched_files(workspace_id, &changes)
        .await)
}

#[tauri::command]
pub async fn lsp_start_workspace_watcher(
    state: State<'_, AppState>,
    workspace_id: String,
    roots: Vec<String>,
) -> Result<(), String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    state
        .workspace
        .lsp
        .start_workspace_watcher(workspace_id, roots)
        .await
}

#[tauri::command]
pub async fn lsp_stop_workspace_watcher(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspace id is required".into());
    }
    state
        .workspace
        .lsp
        .stop_workspace_watcher(workspace_id)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn lsp_open_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: String,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    let session = match state
        .workspace
        .lsp
        .ensure_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Ok(session) => session,
        Err(status) => return Ok(status),
    };
    let language_id = document.language_id.as_deref().unwrap_or("plaintext");
    session
        .notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": document.uri,
                    "languageId": language_id,
                    "version": document.version,
                    "text": text
                }
            }),
        )
        .await
        .map_err(|e| format!("LSP didOpen failed: {e}"))?;
    session
        .opened_documents
        .write()
        .await
        .insert(document.uri.clone());
    Ok(state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_change_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: Option<String>,
    change: Option<LspDocumentContentChange>,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    let Some(session) = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    else {
        let Some(text) = text else {
            return Err("LSP change requires full document text while starting a session".into());
        };
        return lsp_open_document(
            state,
            document.workspace_id.clone(),
            Some(document.root_path.to_string_lossy().into_owned()),
            document.path.to_string_lossy().into_owned(),
            text,
            version,
            document.language_id.clone(),
            server_command_id,
            custom_server_command,
        )
        .await;
    };
    session
        .cancel_document_requests(
            &document.uri,
            "language server request cancelled: document changed",
        )
        .await;
    if !session
        .opened_documents
        .read()
        .await
        .contains(&document.uri)
    {
        let Some(text) = text else {
            return Err("LSP change requires full document text while reopening a document".into());
        };
        let language_id = document.language_id.as_deref().unwrap_or("plaintext");
        session
            .notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": document.uri,
                        "languageId": language_id,
                        "version": document.version,
                        "text": text
                    }
                }),
            )
            .await
            .map_err(|e| format!("LSP didOpen failed: {e}"))?;
        session
            .opened_documents
            .write()
            .await
            .insert(document.uri.clone());
        return Ok(state
            .workspace
            .lsp
            .document_status(
                &document,
                server_command_id.as_deref(),
                custom_server_command.as_ref(),
            )
            .await);
    }
    let content_change = content_change_for_sync(
        text,
        change,
        session.text_document_sync_kind.load(Ordering::SeqCst),
    )?;
    session
        .notify(
            "textDocument/didChange",
            json!({
                "textDocument": {
                    "uri": document.uri,
                    "version": document.version
                },
                "contentChanges": [content_change]
            }),
        )
        .await
        .map_err(|e| format!("LSP didChange failed: {e}"))?;
    Ok(state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_save_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: Option<String>,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    if let Some(session) = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        let mut params = json!({
            "textDocument": { "uri": document.uri }
        });
        if let Some(text) = text {
            params["text"] = Value::String(text);
        }
        session
            .notify("textDocument/didSave", params)
            .await
            .map_err(|e| format!("LSP didSave failed: {e}"))?;
    }
    Ok(state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_close_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    if let Some(session) = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        session
            .cancel_document_requests(
                &document.uri,
                "language server request cancelled: document closed",
            )
            .await;
        session
            .notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": document.uri } }),
            )
            .await
            .map_err(|e| format!("LSP didClose failed: {e}"))?;
        session.opened_documents.write().await.remove(&document.uri);
        session.diagnostics.write().await.remove(&document.uri);
        let _semantic_tokens_guard = session.semantic_tokens_lock.lock().await;
        session
            .semantic_tokens_cache
            .write()
            .await
            .remove(&document.uri);
    }
    Ok(state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_stop_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<usize, String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspaceId is required".into());
    }
    Ok(state.workspace.lsp.stop_workspace(workspace_id).await)
}
