use crate::lsp::navigation::collect_document_symbols;
use crate::lsp::navigation_model::LspDocumentSymbolsResult;
use crate::lsp::paths::resolve_document;
use crate::lsp::paths::with_document_uri;
use crate::lsp::session;
use crate::lsp::status_model::LspCustomServerCommand;
use crate::lsp::symbol_model::LspWorkspaceSymbol;
use crate::lsp::symbol_model::LspWorkspaceSymbolsResult;
use crate::state::AppState;
use serde_json::Value;
use serde_json::json;
use tauri::State;

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
