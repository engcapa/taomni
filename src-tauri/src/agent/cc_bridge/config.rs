use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Configuration for the Claude Code bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcBridgeConfig {
    pub enabled: bool,
    /// "auto" = locate via PATH; or absolute path to binary.
    pub binary: String,
    pub min_version: String,
    pub default_model: String,
    /// "default" | "acceptEdits" | "plan" — never "bypassPermissions"
    pub permission_mode: String,
    pub max_turns: u32,
}

impl Default for CcBridgeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            binary: "auto".into(),
            min_version: super::MIN_VERSION.into(),
            default_model: "sonnet".into(),
            permission_mode: "default".into(),
            max_turns: 20,
        }
    }
}

/// Generate a temporary settings.json for CC that:
/// - Sets permission_mode
/// - Denies access to sensitive directories
pub fn write_temp_settings(
    permission_mode: &str,
    deny_dirs: &[PathBuf],
    out_path: &PathBuf,
) -> std::io::Result<()> {
    let deny_patterns: Vec<String> = deny_dirs
        .iter()
        .map(|d| format!("{}/**", d.to_string_lossy().replace('\\', "/")))
        .collect();

    let settings = serde_json::json!({
        "permissions": {
            "allow": [],
            "deny": deny_patterns
        }
    });

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out_path, serde_json::to_string_pretty(&settings).unwrap())
}

/// Generate a temporary `.mcp.json` for CC. Wires up two stdio MCP servers
/// that re-invoke the NewMob binary with `--mcp-server <name>`:
///
///   - `newmob_permissions` — exposes `permission_prompt`, used via
///     `--permission-prompt-tool mcp__newmob_permissions__permission_prompt`
///     so every tool call CC wants to make routes through NewMob's safety
///     pipeline (blacklist + per-session disable).
///   - `newmob_tools` — exposes the four stateless NewMob tools so CC can
///     call them as if they were native (`web_search`, `web_fetch`,
///     `explain_error`, `redact_text`).
pub fn write_temp_mcp_config(out_path: &PathBuf) -> std::io::Result<()> {
    // Resolve the current binary path so the spawned subprocess is always
    // the same NewMob version that wrote the config.
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "newmob".to_string());

    let mcp = serde_json::json!({
        "mcpServers": {
            "newmob_permissions": {
                "command": exe,
                "args": ["--mcp-server", "permissions"]
            },
            "newmob_tools": {
                "command": exe,
                "args": ["--mcp-server", "tools"]
            }
        }
    });
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out_path, serde_json::to_string_pretty(&mcp).unwrap())
}

/// Permission prompt tool name CC needs via `--permission-prompt-tool`.
/// Format follows MCP convention: `mcp__<server-name>__<tool-name>`.
pub const PERMISSION_PROMPT_TOOL: &str = "mcp__newmob_permissions__permission_prompt";

/// Directories that CC must never access.
pub fn sensitive_deny_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".ssh"));
    }
    if let Some(config) = dirs::config_dir() {
        dirs.push(config.join("newmob"));
    }
    dirs
}
