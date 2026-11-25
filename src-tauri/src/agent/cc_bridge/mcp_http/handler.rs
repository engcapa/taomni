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
        let outcome = request_tool_dispatch(&self.app, &scope.thread_id, tool, args).await;
        if outcome.ok {
            Ok(CallToolResult::success(vec![Content::text(outcome.output)]))
        } else {
            Err(ErrorData::internal_error(outcome.output, None))
        }
    }
}

/// First live candidate window for a side effect: the terminal that will
/// perform it, then the window that owns the thread.
fn effect_window(
    app: &tauri::AppHandle,
    terminal: Option<String>,
    thread_owner: Option<String>,
) -> Option<String> {
    terminal
        .filter(|label| app.get_webview_window(label).is_some())
        .or_else(|| thread_owner.filter(|label| app.get_webview_window(label).is_some()))
}

/// Register one frontend side effect, deliver it to the window that can perform
/// it and wait for the outcome.
///
/// The effect must run in exactly one webview (issue #869: a broadcast ran it in
/// every window, e.g. writing the same command into two terminals).
/// Terminal-writing tools run where the terminal lives, which after a detach is
/// not the chat window; every other tool runs in the window that started the
/// turn. A missing window still falls back to a broadcast so the effect is not
/// silently dropped.
///
/// Shared with the isolated QA probe (`qa_agent_approval_probe`) so a case can
/// dispatch a real effect instead of a stubbed one.
pub(crate) async fn request_tool_dispatch(
    app: &tauri::AppHandle,
    thread_id: &str,
    tool: &str,
    args: serde_json::Value,
) -> CcToolOutcome {
    let call_id = Uuid::new_v4().to_string();
    let state = app.state::<AppState>();
    let mobile = state.legacy.mobile.clone();
    drop(state);
    let _mobile_gate =
        crate::mobile::confirmation::DesktopConfirmation::new(&mobile, &call_id, thread_id, tool);
    let (tx, rx) = tokio::sync::oneshot::channel::<CcToolOutcome>();
    {
        let state = app.state::<AppState>();
        state
            .core
            .agent
            .cc_pending_tool_calls
            .lock()
            .unwrap()
            .insert(call_id.clone(), tx);
    }
    let target = {
        let state = app.state::<AppState>();
        let tab_windows = state
            .core
            .agent
            .cc_tab_windows
            .lock()
            .map(|map| map.clone())
            .unwrap_or_default();
        let thread_owner = state.core.agent.thread_windows.owner(thread_id);
        effect_window(
            app,
            terminal_window_for_tool(tool, &args, &tab_windows),
            thread_owner,
        )
    };
    crate::windowing::thread_delivery::emit_to_window_or_broadcast(
        app,
        target.as_deref(),
        "agent-cc-tool",
        serde_json::json!({
            "callId": call_id,
            "threadId": thread_id,
            "tool": tool,
            "args": args,
        }),
    );

    match tokio::time::timeout(Duration::from_secs(TOOL_TIMEOUT_SECS), rx).await {
        Ok(Ok(outcome)) => outcome,
        _ => {
            // Timed out or sender dropped — clean up the registry slot.
            let state = app.state::<AppState>();
            state
                .core
                .agent
                .cc_pending_tool_calls
                .lock()
                .unwrap()
                .remove(&call_id);
            CcToolOutcome {
                ok: false,
                output: "tool call timed out or was cancelled".to_string(),
            }
        }
    }
}

/// Tools whose effect is performed in the window that hosts the bound terminal.
const TERMINAL_EFFECT_TOOLS: [&str; 2] = ["run_in_terminal", "read_terminal_tail"];

/// Window label that owns the terminal a tool call acts on, when the tool needs
/// a live terminal. `tab_windows` maps a terminal tab id (what CC's tools name)
/// to the window whose terminal panel currently holds it.
fn terminal_window_for_tool(
    tool: &str,
    args: &serde_json::Value,
    tab_windows: &std::collections::HashMap<String, String>,
) -> Option<String> {
    if !TERMINAL_EFFECT_TOOLS.contains(&tool) {
        return None;
    }
    let tab_id = args.get("session_id").and_then(|value| value.as_str())?;
    tab_windows.get(tab_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn tab_windows() -> HashMap<String, String> {
        HashMap::from([("tab-1".to_string(), "terminal-abc".to_string())])
    }

    #[test]
    fn terminal_tools_resolve_the_window_that_holds_the_terminal() {
        for tool in ["run_in_terminal", "read_terminal_tail"] {
            assert_eq!(
                terminal_window_for_tool(tool, &json!({ "session_id": "tab-1" }), &tab_windows())
                    .as_deref(),
                Some("terminal-abc"),
                "{tool} must run where its terminal lives"
            );
        }
    }

    #[test]
    fn terminal_tool_without_a_tracked_tab_has_no_preferred_window() {
        assert_eq!(
            terminal_window_for_tool(
                "run_in_terminal",
                &json!({ "session_id": "tab-unknown" }),
                &tab_windows()
            ),
            None
        );
        assert_eq!(
            terminal_window_for_tool("run_in_terminal", &json!({}), &tab_windows()),
            None
        );
    }

    #[test]
    fn other_side_effects_do_not_use_the_terminal_window() {
        // An SFTP upload or a runbook save acts on the chat window's state, not
        // on the terminal, even when the arguments name a terminal tab.
        assert_eq!(
            terminal_window_for_tool(
                "sftp_upload",
                &json!({ "session_id": "tab-1" }),
                &tab_windows()
            ),
            None
        );
    }
}
