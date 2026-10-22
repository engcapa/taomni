use super::*;

#[tauri::command]
pub async fn lsp_document_highlights(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentHighlightsResult, String> {
    let (status, value) = lsp_document_feature_request(
        state,
        workspace_id,
        root_path,
        file_path,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/documentHighlight",
        json!({ "position": { "line": line, "character": character } }),
    )
    .await?;
    Ok(LspDocumentHighlightsResult {
        status,
        highlights: parse_document_highlights(&value),
    })
}

#[tauri::command]
pub async fn lsp_inlay_hints(
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
) -> Result<LspInlayHintsResult, String> {
    let (status, value) = lsp_document_feature_request(
        state,
        workspace_id,
        root_path,
        file_path,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/inlayHint",
        json!({
            "range": {
                "start": { "line": start_line, "character": start_character },
                "end": { "line": end_line, "character": end_character },
            }
        }),
    )
    .await?;
    Ok(LspInlayHintsResult {
        status,
        hints: parse_inlay_hints(&value),
    })
}

#[tauri::command]
pub async fn lsp_selection_ranges(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspSelectionRangesResult, String> {
    let (status, value) = lsp_document_feature_request(
        state,
        workspace_id,
        root_path,
        file_path,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/selectionRange",
        json!({ "positions": [{ "line": line, "character": character }] }),
    )
    .await?;
    Ok(LspSelectionRangesResult {
        status,
        ranges: parse_selection_ranges(&value),
    })
}

#[tauri::command]
pub async fn lsp_semantic_tokens(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspSemanticTokensResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
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
        return Ok(LspSemanticTokensResult {
            status,
            tokens: Vec::new(),
        });
    };
    if !session
        .capabilities
        .read()
        .await
        .as_ref()
        .map(|caps| caps.semantic_tokens)
        .unwrap_or(false)
    {
        return Ok(LspSemanticTokensResult {
            status,
            tokens: Vec::new(),
        });
    }
    let _semantic_tokens_guard = session.semantic_tokens_lock.lock().await;
    let cached = session
        .semantic_tokens_cache
        .read()
        .await
        .get(&document.uri)
        .cloned();
    let delta_supported = *session.semantic_tokens_delta.read().await;
    let mut resolved = None;
    if delta_supported && let Some(previous) = cached.as_ref() {
        let delta = session
            .request(
                "textDocument/semanticTokens/full/delta",
                json!({
                    "textDocument": { "uri": document.uri },
                    "previousResultId": previous.result_id,
                }),
            )
            .await;
        if let Ok(value) = delta {
            resolved = semantic_token_data_from_response(&value)
                .or_else(|| apply_semantic_token_delta(previous, &value));
        }
    }
    if resolved.is_none() {
        let value = session
            .request(
                "textDocument/semanticTokens/full",
                json!({ "textDocument": { "uri": document.uri } }),
            )
            .await
            .unwrap_or(Value::Null);
        resolved = semantic_token_data_from_response(&value);
    }
    let (data, result_id) = resolved.unwrap_or_default();
    if let Some(result_id) = result_id {
        session.semantic_tokens_cache.write().await.insert(
            document.uri.clone(),
            SemanticTokensCache {
                result_id,
                data: data.clone(),
            },
        );
    } else {
        session
            .semantic_tokens_cache
            .write()
            .await
            .remove(&document.uri);
    }
    let token_types = session.semantic_token_types.read().await.clone();
    let token_modifiers = session.semantic_token_modifiers.read().await.clone();
    let tokens = decode_semantic_token_data(&data, &token_types, &token_modifiers);
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspSemanticTokensResult { status, tokens })
}

pub(super) async fn lsp_document_feature_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    method: &str,
    mut params: Value,
) -> Result<(LspDocumentStatus, Value), String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    params["textDocument"] = json!({ "uri": document.uri });
    let result = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session.request(method, params).await.unwrap_or(Value::Null),
        None => Value::Null,
    };
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok((status, result))
}
