use super::model::TokenScope;
use super::scope::enforce_session_scope;
use super::scope::normalize_tool_name;
use super::scope::tool_uses_bound_session_scope;
use crate::agent::tools::ToolCall;
use crate::state::AppState;
use crate::state::CcPermissionDecision;
use rmcp::ErrorData;
use rmcp::model::CallToolResult;
use rmcp::model::Content;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use uuid::Uuid;

/// How long `permission_prompt` waits for a human decision before defaulting
/// to deny.
pub(super) const PERMISSION_TIMEOUT_SECS: u64 = 300;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Build the CC permission-prompt `allow` reply CC expects from its
/// `--permission-prompt-tool`: `{behavior:"allow", updatedInput:{...}}`.
pub(crate) fn allow_json(input: &serde_json::Value) -> String {
    serde_json::json!({ "behavior": "allow", "updatedInput": input }).to_string()
}

/// Build the CC permission-prompt `deny` reply: `{behavior:"deny", message}`.
pub(crate) fn deny_json(message: impl Into<String>) -> String {
    serde_json::json!({ "behavior": "deny", "message": message.into() }).to_string()
}

pub(crate) fn allow_result(input: &serde_json::Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(allow_json(input))])
}

pub(crate) fn deny_result(message: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(deny_json(message))])
}

/// Emit `agent-cc-permission` and block until a human decision arrives via
/// `cc_resolve_permission` (defaults to deny on timeout). Shared by all flavors.
///
/// The prompt is delivered to the window that started the turn for this thread
/// (issue #869) instead of every webview, so a detached session window cannot
/// render a second copy of the same card.
pub(crate) async fn await_permission(
    app: &AppHandle,
    scope: &TokenScope,
    tool: &str,
    input: &serde_json::Value,
) -> CcPermissionDecision {
    request_permission(app, &scope.thread_id, tool, input, scope.trust.as_str()).await
}

/// Register a permission prompt, deliver it to the thread's owning window and
/// block until it is decided (or times out).
///
/// Split out of [`await_permission`] so the isolated QA build can drive the same
/// delivery/resolution path without a live MCP request (see
/// `qa_agent_approval_probe`).
pub(crate) async fn request_permission(
    app: &AppHandle,
    thread_id: &str,
    tool: &str,
    input: &serde_json::Value,
    trust: &str,
) -> CcPermissionDecision {
    let call_id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<CcPermissionDecision>();
    {
        let state = app.state::<AppState>();
        state
            .agent
            .cc_pending_permissions
            .lock()
            .unwrap()
            .insert(call_id.clone(), tx);
    }
    {
        let state = app.state::<AppState>();
        state.mobile.confirmations.lock().unwrap().insert(
            call_id.clone(),
            serde_json::json!({
                "id":call_id, "thread_id":thread_id, "tool":tool, "supported":true
            }),
        );
        state.mobile.events.publish(serde_json::json!({"type":"task_status", "task_id":format!("thread:{thread_id}"),"status":"awaiting_confirmation", "summary":tool}));
    }
    crate::windowing::thread_delivery::emit_thread_event_for_app(
        app,
        thread_id,
        "agent-cc-permission",
        serde_json::json!({
            "callId": call_id,
            "threadId": thread_id,
            "tool": tool,
            "args": input,
            "trust": trust,
        }),
    );

    let decision =
        match tokio::time::timeout(Duration::from_secs(PERMISSION_TIMEOUT_SECS), rx).await {
            Ok(Ok(decision)) => decision,
            _ => {
                let state = app.state::<AppState>();
                state
                    .agent
                    .cc_pending_permissions
                    .lock()
                    .unwrap()
                    .remove(&call_id);
                // Timeout or a stopped bridge: no decision can arrive any more,
                // so drop the card everywhere instead of leaving a dead prompt
                // that only fails when clicked.
                crate::windowing::thread_delivery::broadcast_cc_permission_resolved(
                    app,
                    Some(&call_id),
                    Some(thread_id),
                );
                CcPermissionDecision::Deny
            }
        };
    let state = app.state::<AppState>();
    let pending: std::collections::HashSet<_> = state
        .agent
        .cc_pending_permissions
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let mut confirmations = state.mobile.confirmations.lock().unwrap();
    if confirmations.len() > 200 {
        confirmations
            .retain(|id, v| v["supported"] != true || pending.contains(id) || id == &call_id);
    }
    drop(confirmations);
    state
        .mobile
        .task_status(thread_id, "running", "confirmation_resolved");
    decision
}

/// The shared `permission_prompt` grading pipeline used by every flavor's
/// `permission_prompt` tool. `raw_tool_name` is CC's `mcp__server__tool` (or a
/// built-in like `Bash`); `is_readonly` is the flavor-specific verdict that a
/// confidently read-only operation may waive the *confirmation* card (never the
/// safety checks, which always run). Returns the CC allow/deny reply.
pub(crate) async fn decide_permission(
    app: &AppHandle,
    scope: &TokenScope,
    raw_tool_name: &str,
    input: &serde_json::Value,
    is_readonly: bool,
) -> CallToolResult {
    let tool_name = normalize_tool_name(raw_tool_name).to_string();
    let uses_bound_session_scope = tool_uses_bound_session_scope(&tool_name);

    // 1. Session/thread scope.
    if uses_bound_session_scope {
        if let Err(reason) = enforce_session_scope(scope, input) {
            return deny_result(reason);
        }
    }
    // 2. Blacklist / sensitive-path deny-list.
    let call = ToolCall {
        tool: tool_name.clone(),
        args: input.clone(),
    };
    if let Err(reason) = crate::agent::safety::check_tool_call(&call) {
        return deny_result(reason);
    }
    // 3. Per-session "AI 写动作禁用".
    if uses_bound_session_scope {
        let state = app.state::<AppState>();
        if let Err(reason) = crate::agent::safety::check_session_disable(&state, &call) {
            return deny_result(reason);
        }
    }
    // 4. Grading: writes need a human unless already approved for session.
    let already = scope.session_approved.lock().unwrap().contains(&tool_name);
    let needs_confirm =
        crate::agent::safety::requires_confirmation(&tool_name) && !already && !is_readonly;
    if !needs_confirm {
        return allow_result(input);
    }
    // 5. Human-in-the-loop.
    match await_permission(app, scope, &tool_name, input).await {
        CcPermissionDecision::Allow => allow_result(input),
        CcPermissionDecision::AllowSession => {
            scope.session_approved.lock().unwrap().insert(tool_name);
            allow_result(input)
        }
        CcPermissionDecision::Deny => deny_result("denied by user"),
    }
}

/// Handler-side permission gate for clients that do not use the Claude Code
/// `permission_prompt` preflight. No-op for legacy Claude tokens.
pub(crate) async fn enforce_inline_permission(
    app: &AppHandle,
    scope: &TokenScope,
    raw_tool_name: &str,
    input: &serde_json::Value,
    is_readonly: bool,
) -> Result<(), ErrorData> {
    if !scope.inline_permission {
        return Ok(());
    }
    let tool_name = normalize_tool_name(raw_tool_name).to_string();
    let uses_bound_session_scope = tool_uses_bound_session_scope(&tool_name);
    if uses_bound_session_scope {
        enforce_session_scope(scope, input).map_err(|e| ErrorData::invalid_params(e, None))?;
    }
    let call = ToolCall {
        tool: tool_name.clone(),
        args: input.clone(),
    };
    crate::agent::safety::check_tool_call(&call).map_err(|e| ErrorData::invalid_params(e, None))?;
    if uses_bound_session_scope {
        let state = app.state::<AppState>();
        crate::agent::safety::check_session_disable(&state, &call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
    }

    let already = scope.session_approved.lock().unwrap().contains(&tool_name);
    let needs_confirm =
        crate::agent::safety::requires_confirmation(&tool_name) && !already && !is_readonly;
    if !needs_confirm {
        return Ok(());
    }
    match await_permission(app, scope, &tool_name, input).await {
        CcPermissionDecision::Allow => Ok(()),
        CcPermissionDecision::AllowSession => {
            scope.session_approved.lock().unwrap().insert(tool_name);
            Ok(())
        }
        CcPermissionDecision::Deny => Err(ErrorData::invalid_params("denied by user", None)),
    }
}
