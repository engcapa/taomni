use crate::lsp::diagnostics::hover_contents;
use crate::lsp::navigation_model::LspHoverResult;
use crate::lsp::paths::resolve_document;
use crate::lsp::paths::with_document_uri;
use crate::lsp::protocol::parse_range;
use crate::lsp::session;
use crate::lsp::status_model::LspCustomServerCommand;
use crate::lsp::workspace_symbols::begin_reference_request;
use crate::lsp::workspace_symbols::finish_reference_request;
use crate::state::AppState;
use serde_json::Value;
use serde_json::json;
use tauri::State;
use tokio_util::sync::CancellationToken;

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
