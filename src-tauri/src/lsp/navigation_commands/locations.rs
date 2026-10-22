use crate::lsp::navigation::parse_locations;
use crate::lsp::navigation_model::LspLocationsResult;
use crate::lsp::paths::resolve_document;
use crate::lsp::paths::with_document_uri;
use crate::lsp::session;
use crate::lsp::status_model::LspCustomServerCommand;
use crate::lsp::workspace_symbols::begin_reference_request;
use crate::lsp::workspace_symbols::cancel_reference_request;
use crate::lsp::workspace_symbols::finish_reference_request;
use crate::state::AppState;
use serde_json::Value;
use serde_json::json;
use tauri::State;
use tokio_util::sync::CancellationToken;

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

pub(in crate::lsp) async fn lsp_location_request(
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
