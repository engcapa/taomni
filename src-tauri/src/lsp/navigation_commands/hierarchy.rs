use crate::lsp::navigation::parse_call_hierarchy_entries;
use crate::lsp::navigation::parse_hierarchy_items;
use crate::lsp::navigation_model::LspCallHierarchyResult;
use crate::lsp::navigation_model::LspHierarchyPrepareResult;
use crate::lsp::navigation_model::LspTypeHierarchyResult;
use crate::lsp::paths::resolve_document;
use crate::lsp::session;
use crate::lsp::status_model::LspCustomServerCommand;
use crate::lsp::status_model::LspDocumentStatus;
use crate::lsp::workspace_symbols::begin_reference_request;
use crate::lsp::workspace_symbols::finish_reference_request;
use crate::state::AppState;
use serde_json::Value;
use serde_json::json;
use tauri::State;
use tokio_util::sync::CancellationToken;

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

pub(in crate::lsp) async fn lsp_hierarchy_prepare_request(
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

pub(in crate::lsp) async fn lsp_hierarchy_item_request(
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
