use super::tools::ToolCall;
use crate::state::AppState;

/// Enforce safety rules on tool calls before execution.
/// Returns Err with a human-readable reason if the call should be blocked.
pub fn check_tool_call(call: &ToolCall) -> Result<(), String> {
    match call.tool.as_str() {
        "run_in_terminal" => {
            // Shell command blacklist check.
            if let Some(cmd) = call.args.get("command").and_then(|v| v.as_str()) {
                let safety = crate::ai::shell_safety::check_blacklist(cmd);
                if safety.blocked {
                    return Err(format!(
                        "Command blocked by safety rules: {}",
                        safety.reason.unwrap_or_default()
                    ));
                }
            }
            Ok(())
        }
        "read_terminal_tail" => {
            // Must have user_invoked=true.
            let user_invoked = call
                .args
                .get("user_invoked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !user_invoked {
                return Err("read_terminal_tail requires user_invoked=true".into());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Enforce session-level "禁用 AI 写动作" flag for write tools.
/// Returns Err if the call's session has the flag set AND this is a write tool.
pub fn check_session_disable(state: &AppState, call: &ToolCall) -> Result<(), String> {
    if !is_write_tool(&call.tool) {
        return Ok(());
    }
    let Some(session_id) = call.args.get("session_id").and_then(|v| v.as_str()) else {
        return Ok(()); // no session = no per-session enforcement (e.g. local-only ops)
    };
    if crate::ai::session_safety::is_ai_write_disabled(state, session_id) {
        return Err(format!(
            "session {} has AI write actions disabled — only preview/copy is allowed",
            session_id
        ));
    }
    Ok(())
}

/// Returns true if this tool performs a write/destructive action that should
/// be blocked under per-session disable + go through confirmation cards.
pub fn is_write_tool(tool: &str) -> bool {
    matches!(tool, "run_in_terminal" | "sftp_upload" | "save_as_runbook")
}

/// Returns true if this tool requires explicit user confirmation before execution.
pub fn requires_confirmation(tool: &str) -> bool {
    is_write_tool(tool)
}
