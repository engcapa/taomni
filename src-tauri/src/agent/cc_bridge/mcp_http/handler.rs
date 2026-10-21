use super::model::TokenMap;
use super::model::TokenScope;
use super::scope::scope_from_ctx;
use crate::state::AppState;
use crate::state::CcToolOutcome;
use rmcp::ErrorData;
use rmcp::handler::server::tool::ToolRouter;
use rmcp::model::CallToolResult;
use rmcp::model::Content;
use rmcp::service::RequestContext;
use rmcp::service::RoleServer;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use uuid::Uuid;

/// How long a side-effect tool waits for the frontend to perform the effect.
pub(crate) const TOOL_TIMEOUT_SECS: u64 = 600;

#[derive(Clone)]
pub(super) struct CcHandler {
    pub(super) app: AppHandle,
    pub(super) tokens: TokenMap,
    pub(super) tool_router: ToolRouter<Self>,
}

impl CcHandler {
    pub(super) fn new(app: AppHandle, tokens: TokenMap) -> Self {
        Self {
            app,
            tokens,
            tool_router: Self::tool_router(),
        }
    }

    /// Resolve the calling token's scope from the request's Bearer header.
    pub(super) fn scope(&self, ctx: &RequestContext<RoleServer>) -> Result<TokenScope, ErrorData> {
        scope_from_ctx(&self.tokens, ctx)
    }

    pub(super) fn app_state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    /// Emit an `agent-cc-tool` event and block until the frontend performs the
    /// effect and calls `cc_resolve_tool_call` (or we time out).
    pub(super) async fn dispatch_side_effect(
        &self,
        scope: &TokenScope,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<CallToolResult, ErrorData> {
        let call_id = Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<CcToolOutcome>();
        {
            let state = self.app_state();
            state
                .agent
                .cc_pending_tool_calls
                .lock()
                .unwrap()
                .insert(call_id.clone(), tx);
        }
        let _ = self.app.emit(
            "agent-cc-tool",
            serde_json::json!({
                "callId": call_id,
                "threadId": scope.thread_id,
                "tool": tool,
                "args": args,
            }),
        );

        match tokio::time::timeout(Duration::from_secs(TOOL_TIMEOUT_SECS), rx).await {
            Ok(Ok(outcome)) if outcome.ok => {
                Ok(CallToolResult::success(vec![Content::text(outcome.output)]))
            }
            Ok(Ok(outcome)) => Err(ErrorData::internal_error(outcome.output, None)),
            _ => {
                // Timed out or sender dropped — clean up the registry slot.
                let state = self.app_state();
                state
                    .agent
                    .cc_pending_tool_calls
                    .lock()
                    .unwrap()
                    .remove(&call_id);
                Err(ErrorData::internal_error(
                    "tool call timed out or was cancelled".to_string(),
                    None,
                ))
            }
        }
    }
}
