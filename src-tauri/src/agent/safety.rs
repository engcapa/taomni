use super::tools::ToolCall;
use crate::state::AppState;
use std::path::{Path, PathBuf};

/// Enforce safety rules on tool calls before execution.
/// Returns Err with a human-readable reason if the call should be blocked.
///
/// This is the single chokepoint for both the native agent loop
/// (`agent::mod`) and Claude Code's `permission_prompt` bridge
/// (`cc_bridge::mcp_http`). CC drives a different tool vocabulary
/// (`Bash`/`Read`/`Edit`/`Write`/`NotebookEdit`) than the native tools
/// (`run_in_terminal`/`read_terminal_tail`/…), so both are mapped here —
/// otherwise a CC `Bash` call would fall through to the catch-all and skip
/// the shell blacklist entirely.
pub fn check_tool_call(call: &ToolCall) -> Result<(), String> {
    match call.tool.as_str() {
        // Native terminal command + CC's Bash both carry the command under
        // `command`; run both through the shell blacklist. `run_captured`
        // (方案4) is the same — a command executed on the bound host.
        "run_in_terminal" | "Bash" | "run_captured" => {
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
        // CC's file tools take a path. Block any access (read or write) that
        // resolves inside a sensitive directory so the path tools can't be
        // used to bypass the settings-level deny-list.
        "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            if let Some(path) = tool_call_path(call) {
                let deny = crate::agent::cc_bridge::config::sensitive_deny_dirs();
                if path_is_denied(&path, &deny, dirs::home_dir().as_deref()) {
                    return Err(format!(
                        "Access to sensitive path blocked by safety rules: {}",
                        path
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

/// Extract the target path from a CC file tool call. CC uses `file_path` for
/// Read/Edit/Write/MultiEdit and `notebook_path` for NotebookEdit.
fn tool_call_path(call: &ToolCall) -> Option<String> {
    call.args
        .get("file_path")
        .or_else(|| call.args.get("notebook_path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Returns true if `path` resolves inside a sensitive directory (ssh keys, app
/// config, …). Public so the read-only command classifier (3.6,
/// `agent::cmd_classify`) can refuse to silently auto-allow a read-only command
/// that would dump a secret path's contents into the model context. Mirrors the
/// deny check applied to CC's file tools in `check_tool_call`.
pub fn path_is_sensitive(path: &str) -> bool {
    let deny = crate::agent::cc_bridge::config::sensitive_deny_dirs();
    path_is_denied(path, &deny, dirs::home_dir().as_deref())
}

/// Returns true if `path` resolves inside any of `deny_dirs`. Performs leading
/// `~` expansion (using `home`) and lexical normalization (resolving `.`/`..`)
/// without touching the filesystem — the target file need not exist, and we
/// must not follow symlinks for a deny check.
fn path_is_denied(path: &str, deny_dirs: &[PathBuf], home: Option<&Path>) -> bool {
    let expanded = expand_tilde(path, home);
    let normalized = normalize_lexical(&expanded);
    deny_dirs.iter().any(|d| {
        let dn = normalize_lexical(&d.to_string_lossy());
        if dn.is_empty() {
            return false;
        }
        normalized == dn || normalized.starts_with(&format!("{}/", dn.trim_end_matches('/')))
    })
}

/// Expand a leading `~` (or `~/`) to the home directory. Other uses of `~`
/// (e.g. `~user`) are left untouched.
fn expand_tilde(path: &str, home: Option<&Path>) -> String {
    if let Some(home) = home {
        if path == "~" {
            return home.to_string_lossy().to_string();
        }
        if let Some(rest) = path.strip_prefix("~/") {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

/// Lexically normalize a path string: collapse `.`, resolve `..`, and strip
/// redundant separators. Preserves a leading `/` (absolute) marker. Does not
/// touch the filesystem.
fn normalize_lexical(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for comp in path.split('/') {
        match comp {
            "" | "." => continue,
            ".." => {
                if matches!(out.last(), Some(&c) if c != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            c => out.push(c),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{}", joined)
    } else {
        joined
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
///
/// Covers both the native vocabulary and CC's write tools (`Bash` can run
/// arbitrary mutating commands; `Write`/`Edit`/`MultiEdit`/`NotebookEdit`
/// mutate files), so confirmation cards and the per-session AI-write disable
/// flag apply uniformly regardless of which driver issued the call.
pub fn is_write_tool(tool: &str) -> bool {
    matches!(
        tool,
        "run_in_terminal"
            | "run_captured"
            | "sftp_upload"
            | "save_as_runbook"
            | "Bash"
            | "Write"
            | "Edit"
            | "MultiEdit"
            | "NotebookEdit"
    )
}

/// Returns true if this tool requires explicit user confirmation before execution.
pub fn requires_confirmation(tool: &str) -> bool {
    is_write_tool(tool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn deny_dirs() -> Vec<PathBuf> {
        vec![
            PathBuf::from("/home/u/.ssh"),
            PathBuf::from("/home/u/.config/taomni"),
        ]
    }

    fn call(tool: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            tool: tool.into(),
            args,
        }
    }

    #[test]
    fn bash_rm_rf_root_is_blocked() {
        let c = call("Bash", json!({ "command": "rm -rf /" }));
        assert!(check_tool_call(&c).is_err(), "rm -rf / must be blocked");
    }

    #[test]
    fn bash_benign_command_is_allowed() {
        let c = call("Bash", json!({ "command": "ls -la" }));
        assert!(check_tool_call(&c).is_ok());
    }

    #[test]
    fn read_ssh_key_is_blocked() {
        let home = Path::new("/home/u");
        assert!(path_is_denied("~/.ssh/id_rsa", &deny_dirs(), Some(home)));
        assert!(path_is_denied(
            "/home/u/.ssh/id_rsa",
            &deny_dirs(),
            Some(home)
        ));
    }

    #[test]
    fn read_ssh_dir_itself_is_blocked() {
        let home = Path::new("/home/u");
        assert!(path_is_denied("/home/u/.ssh", &deny_dirs(), Some(home)));
    }

    #[test]
    fn dotdot_traversal_into_ssh_is_blocked() {
        let home = Path::new("/home/u");
        assert!(path_is_denied(
            "/home/u/project/../.ssh/id_rsa",
            &deny_dirs(),
            Some(home)
        ));
    }

    #[test]
    fn read_outside_deny_is_allowed() {
        let home = Path::new("/home/u");
        assert!(!path_is_denied(
            "/home/u/project/main.rs",
            &deny_dirs(),
            Some(home)
        ));
        // A sibling whose name merely starts with the deny dir name must not match.
        assert!(!path_is_denied(
            "/home/u/.sshconfig",
            &deny_dirs(),
            Some(home)
        ));
    }

    #[test]
    fn read_tool_call_blocks_ssh_via_check() {
        // Smoke the full check_tool_call path with whatever the real home dir
        // is: an absolute path under ~/.ssh must be denied.
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".ssh").join("id_rsa");
            let c = call("Read", json!({ "file_path": p.to_string_lossy() }));
            assert!(check_tool_call(&c).is_err());
        }
    }

    #[test]
    fn notebook_edit_uses_notebook_path() {
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".ssh").join("secret.ipynb");
            let c = call(
                "NotebookEdit",
                json!({ "notebook_path": p.to_string_lossy() }),
            );
            assert!(check_tool_call(&c).is_err());
        }
    }

    #[test]
    fn cc_write_tools_require_confirmation() {
        for t in ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"] {
            assert!(requires_confirmation(t), "{t} should require confirmation");
            assert!(is_write_tool(t), "{t} should be a write tool");
        }
        assert!(!requires_confirmation("Read"));
    }

    #[test]
    fn run_captured_is_a_confirmed_command_tool() {
        // 方案4 — run_captured executes a command on the bound host, so it must
        // run the shell blacklist and require confirmation, while read_capture
        // (read-only) does not.
        assert!(requires_confirmation("run_captured"));
        assert!(is_write_tool("run_captured"));
        assert!(!is_write_tool("read_capture"));
        let blocked = call("run_captured", json!({ "command": "rm -rf /" }));
        assert!(check_tool_call(&blocked).is_err(), "rm -rf / must be blocked");
        let ok = call("run_captured", json!({ "command": "journalctl -n 100000" }));
        assert!(check_tool_call(&ok).is_ok());
    }
}
