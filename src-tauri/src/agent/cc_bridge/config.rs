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
    let deny_patterns: Vec<String> = deny_dirs.iter()
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

/// Generate a temporary .mcp.json for CC (empty for now — NewMob tools MCP is future work).
pub fn write_temp_mcp_config(out_path: &PathBuf) -> std::io::Result<()> {
    let mcp = serde_json::json!({ "mcpServers": {} });
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out_path, serde_json::to_string_pretty(&mcp).unwrap())
}

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
