use super::*;

#[tauri::command]
pub async fn lsp_hover(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspHoverResult, String> {
    let document = with_document_uri(
        resolve_document(workspace_id, root_path, file_path, language_id, 0)?,
        document_uri,
    );
    let cancellation = match (cancel_key.as_deref(), request_seq) {
        (Some(key), Some(seq)) => begin_reference_request(key, seq),
        _ => CancellationToken::new(),
    };
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
            finish_reference_request(cancel_key.as_deref(), request_seq);
            return Ok(LspHoverResult {
                status,
                contents: None,
                range: None,
            });
        }
    };
    // §8.18.6: when the caller supplies a cancellation identity, a newer
    // request for the same key aborts this one via `$/cancelRequest` and the
    // in-flight await returns immediately instead of racing the response.
    let result = session
        .request_with_cancellation(
            "textDocument/hover",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character }
            }),
            &cancellation,
        )
        .await
        .unwrap_or(Value::Null);
    finish_reference_request(cancel_key.as_deref(), request_seq);
    if cancellation.is_cancelled() {
        // Cancelled requests report no content; the status snapshot stays
        // fresh so the next hover can proceed immediately.
        let status = state
            .workspace
            .lsp
            .document_status(
                &document,
                server_command_id.as_deref(),
                custom_server_command.as_ref(),
            )
            .await;
        return Ok(LspHoverResult {
            status,
            contents: None,
            range: None,
        });
    }
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspHoverResult {
        status,
        contents: hover_contents(&result),
        range: result.get("range").and_then(parse_range),
    })
}

/// §8.18.6: cancel an in-flight reference request without issuing a
/// replacement (popup close, workspace unmount). Returns true when a live
/// request was actually aborted.
#[tauri::command]
pub fn lsp_cancel_reference_request(cancel_key: String, request_seq: Option<u64>) -> bool {
    cancel_reference_request(&cancel_key, request_seq)
}

#[tauri::command]
pub async fn lsp_definition(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "textDocument/definition",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_declaration(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "textDocument/declaration",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_references(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    include_declaration: Option<bool>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "textDocument/references",
        json!({
            "context": {
                "includeDeclaration": include_declaration.unwrap_or(true)
            }
        }),
    )
    .await
}

pub(super) async fn lsp_location_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
    method: &str,
    mut extra: Value,
) -> Result<LspLocationsResult, String> {
    let document = with_document_uri(
        resolve_document(workspace_id, root_path, file_path, language_id, 0)?,
        document_uri,
    );
    let cancellation = match (cancel_key.as_deref(), request_seq) {
        (Some(key), Some(seq)) => begin_reference_request(key, seq),
        _ => CancellationToken::new(),
    };
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
            finish_reference_request(cancel_key.as_deref(), request_seq);
            return Ok(LspLocationsResult {
                status,
                locations: Vec::new(),
            });
        }
    };
    extra["textDocument"] = json!({ "uri": document.uri });
    extra["position"] = json!({ "line": line, "character": character });
    let result = match session
        .request_with_cancellation(method, extra, &cancellation)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            finish_reference_request(cancel_key.as_deref(), request_seq);
            return Err(error);
        }
    };
    finish_reference_request(cancel_key.as_deref(), request_seq);
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspLocationsResult {
        status,
        locations: parse_locations(&result),
    })
}

#[tauri::command]
pub async fn lsp_document_symbols(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentSymbolsResult, String> {
    let document = with_document_uri(
        resolve_document(workspace_id, root_path, file_path, language_id, 0)?,
        document_uri,
    );
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
            return Ok(LspDocumentSymbolsResult {
                status,
                symbols: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/documentSymbol",
            json!({ "textDocument": { "uri": document.uri } }),
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
    let mut symbols = Vec::new();
    collect_document_symbols(&result, 0, &mut symbols);
    Ok(LspDocumentSymbolsResult { status, symbols })
}

#[tauri::command]
pub async fn lsp_type_definition(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "textDocument/typeDefinition",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_implementation(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "textDocument/implementation",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_workspace_symbols(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    query: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspWorkspaceSymbolsResult, String> {
    // Any open document under the workspace is enough to provide a status
    // context. The actual query fans out across every ready provider session
    // belonging to this workspace (including other roots/languages).
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
    let aggregation = state
        .workspace
        .lsp
        .workspace_symbols(&document.workspace_id, &query)
        .await?;
    Ok(LspWorkspaceSymbolsResult {
        status,
        symbols: aggregation.symbols,
        session_count: aggregation.session_count,
        provider_count: aggregation.provider_count,
        skipped_provider_count: aggregation.skipped_provider_count,
        failed_provider_count: aggregation.failed_provider_count,
        complete: aggregation.complete,
        truncated: aggregation.truncated,
        diagnostics: aggregation.diagnostics,
    })
}

#[tauri::command]
pub async fn lsp_workspace_symbol_resolve(
    state: State<'_, AppState>,
    workspace_id: String,
    resolve_token: String,
) -> Result<LspWorkspaceSymbol, String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspaceId is required".into());
    }
    let resolve_token = resolve_token.trim();
    if resolve_token.is_empty() {
        return Err("resolveToken is required".into());
    }
    state
        .workspace
        .lsp
        .resolve_workspace_symbol(workspace_id, resolve_token)
        .await
}

#[tauri::command]
pub async fn lsp_prepare_call_hierarchy(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspHierarchyPrepareResult, String> {
    lsp_hierarchy_prepare_request(
        state,
        workspace_id,
        root_path,
        file_path,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "textDocument/prepareCallHierarchy",
    )
    .await
}

#[tauri::command]
pub async fn lsp_prepare_type_hierarchy(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspHierarchyPrepareResult, String> {
    lsp_hierarchy_prepare_request(
        state,
        workspace_id,
        root_path,
        file_path,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "textDocument/prepareTypeHierarchy",
    )
    .await
}

pub(super) async fn lsp_hierarchy_prepare_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
    method: &str,
) -> Result<LspHierarchyPrepareResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let cancellation = match (cancel_key.as_deref(), request_seq) {
        (Some(key), Some(seq)) => begin_reference_request(key, seq),
        _ => CancellationToken::new(),
    };
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
        let status = state
            .workspace
            .lsp
            .document_status(
                &document,
                server_command_id.as_deref(),
                custom_server_command.as_ref(),
            )
            .await;
        finish_reference_request(cancel_key.as_deref(), request_seq);
        return Ok(LspHierarchyPrepareResult {
            status,
            items: Vec::new(),
        });
    };
    let result = session
        .request_with_cancellation(
            method,
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
            }),
            &cancellation,
        )
        .await
        .unwrap_or(Value::Null);
    finish_reference_request(cancel_key.as_deref(), request_seq);
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspHierarchyPrepareResult {
        status,
        items: parse_hierarchy_items(&result),
    })
}

#[tauri::command]
pub async fn lsp_call_hierarchy_incoming(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspCallHierarchyResult, String> {
    let (status, value) = lsp_hierarchy_item_request(
        state,
        workspace_id,
        root_path,
        file_path,
        item,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "callHierarchy/incomingCalls",
    )
    .await?;
    Ok(LspCallHierarchyResult {
        status,
        entries: parse_call_hierarchy_entries(&value, "from"),
    })
}

#[tauri::command]
pub async fn lsp_call_hierarchy_outgoing(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspCallHierarchyResult, String> {
    let (status, value) = lsp_hierarchy_item_request(
        state,
        workspace_id,
        root_path,
        file_path,
        item,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "callHierarchy/outgoingCalls",
    )
    .await?;
    Ok(LspCallHierarchyResult {
        status,
        entries: parse_call_hierarchy_entries(&value, "to"),
    })
}

#[tauri::command]
pub async fn lsp_type_hierarchy_supertypes(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspTypeHierarchyResult, String> {
    let (status, value) = lsp_hierarchy_item_request(
        state,
        workspace_id,
        root_path,
        file_path,
        item,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "typeHierarchy/supertypes",
    )
    .await?;
    Ok(LspTypeHierarchyResult {
        status,
        items: parse_hierarchy_items(&value),
    })
}

#[tauri::command]
pub async fn lsp_type_hierarchy_subtypes(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspTypeHierarchyResult, String> {
    let (status, value) = lsp_hierarchy_item_request(
        state,
        workspace_id,
        root_path,
        file_path,
        item,
        language_id,
        server_command_id,
        custom_server_command,
        cancel_key,
        request_seq,
        "typeHierarchy/subtypes",
    )
    .await?;
    Ok(LspTypeHierarchyResult {
        status,
        items: parse_hierarchy_items(&value),
    })
}

pub(super) async fn lsp_hierarchy_item_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
    method: &str,
) -> Result<(LspDocumentStatus, Value), String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let cancellation = match (cancel_key.as_deref(), request_seq) {
        (Some(key), Some(seq)) => begin_reference_request(key, seq),
        _ => CancellationToken::new(),
    };
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
        Some(session) => session
            .request_with_cancellation(method, json!({ "item": item }), &cancellation)
            .await
            .unwrap_or(Value::Null),
        None => {
            finish_reference_request(cancel_key.as_deref(), request_seq);
            Value::Null
        }
    };
    finish_reference_request(cancel_key.as_deref(), request_seq);
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
