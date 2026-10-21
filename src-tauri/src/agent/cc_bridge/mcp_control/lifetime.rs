use super::response::text;
use crate::agent::cc_bridge::mcp_http::TOOL_TIMEOUT_SECS;
use crate::agent::cc_bridge::mcp_http::TokenMap;
use crate::agent::cc_bridge::mcp_http::TokenScope;
use crate::agent::cc_bridge::mcp_http::enforce_inline_permission;
use crate::agent::cc_bridge::mcp_http::scope_from_ctx;
use crate::agent::tools::ToolCall;
use crate::state::AppState;
use crate::state::CcToolOutcome;
use rmcp::ErrorData;
use rmcp::handler::server::tool::ToolRouter;
use rmcp::model::CallToolResult;
use rmcp::model::Content;
use rmcp::service::RequestContext;
use rmcp::service::RoleServer;
use rmcp::tool;
use rmcp::tool_router;
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use uuid::Uuid;

#[derive(Clone)]
pub struct ControlHandler {
    pub(super) app: AppHandle,
    pub(super) tokens: TokenMap,
    pub(super) tool_router: ToolRouter<Self>,
}

impl ControlHandler {
    pub fn new(app: AppHandle, tokens: TokenMap) -> Self {
        Self {
            app,
            tokens,
            tool_router: Self::tool_router(),
        }
    }

    pub(super) fn scope(&self, ctx: &RequestContext<RoleServer>) -> Result<TokenScope, ErrorData> {
        scope_from_ctx(&self.tokens, ctx)
    }

    pub(super) fn app_state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    pub(super) fn emit_sessions_changed(&self) {
        let _ = self
            .app
            .emit("taomni-sessions-changed", serde_json::json!({}));
    }

    pub(super) async fn require_write(
        &self,
        scope: &TokenScope,
        tool: &str,
        args: &Value,
    ) -> Result<(), ErrorData> {
        let call = ToolCall {
            tool: tool.to_string(),
            args: args.clone(),
        };
        crate::agent::safety::check_tool_call(&call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        enforce_inline_permission(&self.app, scope, tool, args, false).await
    }

    pub(super) async fn dispatch_control_side_effect(
        &self,
        scope: &TokenScope,
        tool: &str,
        args: Value,
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
        let payload = serde_json::json!({
            "callId": call_id,
            "threadId": scope.thread_id,
            "tool": tool,
            "args": args,
        });
        let _ = self.app.emit("agent-cc-control-tool", payload.clone());
        {
            let app = self.app.clone();
            let call_id = call_id.clone();
            tokio::spawn(async move {
                for _ in 0..20 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let still_pending = {
                        let state = app.state::<AppState>();
                        state
                            .agent
                            .cc_pending_tool_calls
                            .lock()
                            .map(|calls| calls.contains_key(&call_id))
                            .unwrap_or(false)
                    };
                    if !still_pending {
                        break;
                    }
                    let _ = app.emit("agent-cc-control-tool", payload.clone());
                }
            });
        }

        match tokio::time::timeout(Duration::from_secs(TOOL_TIMEOUT_SECS), rx).await {
            Ok(Ok(outcome)) if outcome.ok => {
                Ok(CallToolResult::success(vec![Content::text(outcome.output)]))
            }
            Ok(Ok(outcome)) => Err(ErrorData::internal_error(outcome.output, None)),
            _ => {
                let state = self.app_state();
                state
                    .agent
                    .cc_pending_tool_calls
                    .lock()
                    .unwrap()
                    .remove(&call_id);
                Err(ErrorData::internal_error(
                    "control tool call timed out or was cancelled".to_string(),
                    None,
                ))
            }
        }
    }
}
