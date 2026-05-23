use super::tools::ToolCall;

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
            let user_invoked = call.args.get("user_invoked")
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

/// Returns true if this tool requires explicit user confirmation before execution.
pub fn requires_confirmation(tool: &str) -> bool {
    matches!(tool, "run_in_terminal" | "sftp_upload" | "save_as_runbook")
}
