use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
    /// Optional reference to a user-supplied Claude Code `settings.json`.
    /// Almost always a `vault:<id>` reference (the raw JSON usually carries an
    /// `ANTHROPIC_AUTH_TOKEN`, so it's stored encrypted in the credential
    /// vault and only resolved at launch time). Empty/None = use the built-in
    /// default settings (safety deny-list only).
    #[serde(default)]
    pub custom_settings_ref: Option<String>,
    /// Whether the custom settings are currently active. Allows toggling off
    /// without deleting the vault entry. Defaults to true so existing configs
    /// (written before this field existed) keep working after upgrade.
    #[serde(default = "default_true")]
    pub custom_settings_enabled: bool,
}

fn default_true() -> bool { true }

impl Default for CcBridgeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            binary: "auto".into(),
            min_version: super::MIN_VERSION.into(),
            default_model: "sonnet".into(),
            permission_mode: "default".into(),
            max_turns: 20,
            custom_settings_ref: None,
            custom_settings_enabled: true,
        }
    }
}

/// Temp files backing one Claude Code session. The whole `dir` is owned by
/// the `CcProcess` and removed when the session stops, so the (possibly
/// secret-bearing) settings file never lingers in the temp directory.
pub struct CcSessionFiles {
    /// Obscure temp directory holding the files below.
    pub dir: PathBuf,
    pub settings_path: PathBuf,
    pub mcp_path: PathBuf,
}

/// Build the effective CC `settings.json` value.
///
/// Starts from the user's custom settings (when configured & resolvable) and
/// always force-merges the mandatory safety deny-list, so CC can never be
/// configured to read `~/.ssh`, the vault, or the Taomni config directory —
/// even if the user's pasted settings omit (or try to relax) those denies.
///
/// With `custom = None` this returns exactly the legacy deny-list-only
/// settings, so the default (no custom config) launch is byte-for-byte
/// equivalent to the previous behaviour.
pub fn build_settings_value(
    custom: Option<&str>,
    deny_dirs: &[PathBuf],
) -> Result<serde_json::Value, String> {
    let deny_patterns: Vec<String> = deny_dirs
        .iter()
        .map(|d| format!("{}/**", d.to_string_lossy().replace('\\', "/")))
        .collect();

    // Base document: the user's custom JSON object, or an empty object.
    let mut root = match custom {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<serde_json::Value>(s)
            .map_err(|e| format!("Invalid custom Claude Code settings JSON: {e}"))?,
        _ => serde_json::json!({}),
    };
    let obj = root
        .as_object_mut()
        .ok_or("Claude Code settings must be a JSON object")?;

    // Ensure a `permissions` object exists.
    let perms = obj
        .entry("permissions")
        .or_insert_with(|| serde_json::json!({}));
    let perms_obj = perms
        .as_object_mut()
        .ok_or("Claude Code settings: \"permissions\" must be an object")?;
    perms_obj
        .entry("allow")
        .or_insert_with(|| serde_json::json!([]));
    let deny = perms_obj
        .entry("deny")
        .or_insert_with(|| serde_json::json!([]));
    let deny_arr = deny
        .as_array_mut()
        .ok_or("Claude Code settings: \"permissions.deny\" must be an array")?;
    // Union the mandatory safety denies (don't duplicate existing entries).
    for pattern in deny_patterns {
        let value = serde_json::Value::String(pattern);
        if !deny_arr.contains(&value) {
            deny_arr.push(value);
        }
    }

    Ok(root)
}

/// Resolve the user's custom CC settings JSON from the config's vault
/// reference.
/// - `Ok(None)` — no custom settings configured.
/// - `Ok(Some(json))` — the raw settings JSON (resolved from the vault, or
///   taken literally when the field isn't a `vault:<id>` reference).
/// - `Err("VAULT_LOCKED: …")` — a reference is set but the vault is locked;
///   the caller surfaces this so the UI can prompt for unlock.
pub fn resolve_custom_settings(
    cfg: &CcBridgeConfig,
    vault: &Vault,
) -> Result<Option<String>, String> {
    // Either not configured or explicitly disabled — fall through to defaults.
    if !cfg.custom_settings_enabled {
        return Ok(None);
    }
    let reference = match cfg.custom_settings_ref.as_ref() {
        Some(r) if !r.trim().is_empty() => r,
        _ => return Ok(None),
    };
    match vault.resolve(reference) {
        Ok(Some(plaintext)) => Ok(Some(plaintext.to_string())),
        // Not a vault reference — treat the stored value as literal JSON.
        Ok(None) => Ok(Some(reference.clone())),
        Err(e) if e.contains(crate::vault::ERR_VAULT_LOCKED) => Err(format!(
            "{}: unlock the credential vault to use your custom Claude Code settings.",
            crate::vault::ERR_VAULT_LOCKED
        )),
        Err(e) => Err(e),
    }
}

/// Write `value` to `out_path` (creating parents), pretty-printed.
fn write_settings_file(value: &serde_json::Value, out_path: &Path) -> std::io::Result<()> {
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out_path, serde_json::to_string_pretty(value).unwrap())
}

/// Create an obscure per-session temp directory under the system temp dir and
/// write the effective settings (custom + mandatory safety deny-list) plus the
/// MCP config. The directory and the settings filename are randomized so the
/// file holding the user's credentials is not trivially discoverable, and the
/// returned `dir` is handed to the `CcProcess` for deletion on stop/drop.
pub fn create_session_files(custom: Option<&str>) -> Result<CcSessionFiles, String> {
    let dir = std::env::temp_dir().join(format!(".{}", uuid::Uuid::new_v4().simple()));
    let settings_path = dir.join(format!("{}.json", uuid::Uuid::new_v4().simple()));
    let mcp_path = dir.join(".mcp.json");

    let value = build_settings_value(custom, &sensitive_deny_dirs())?;
    write_settings_file(&value, &settings_path)
        .map_err(|e| format!("Failed to write CC settings: {e}"))?;
    write_temp_mcp_config(&mcp_path).map_err(|e| format!("Failed to write CC MCP config: {e}"))?;

    Ok(CcSessionFiles {
        dir,
        settings_path,
        mcp_path,
    })
}

/// Generate a temporary `.mcp.json` for CC. Wires up two stdio MCP servers
/// that re-invoke the Taomni binary with `--mcp-server <name>`:
///
///   - `taomni_permissions` — exposes `permission_prompt`, used via
///     `--permission-prompt-tool mcp__taomni_permissions__permission_prompt`
///     so every tool call CC wants to make routes through Taomni's safety
///     pipeline (blacklist + per-session disable).
///   - `taomni_tools` — exposes the four stateless Taomni tools so CC can
///     call them as if they were native (`web_search`, `web_fetch`,
///     `explain_error`, `redact_text`).
pub fn write_temp_mcp_config(out_path: &PathBuf) -> std::io::Result<()> {
    // Resolve the current binary path so the spawned subprocess is always
    // the same Taomni version that wrote the config.
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "taomni".to_string());

    let mcp = serde_json::json!({
        "mcpServers": {
            "taomni_permissions": {
                "command": exe,
                "args": ["--mcp-server", "permissions"]
            },
            "taomni_tools": {
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
pub const PERMISSION_PROMPT_TOOL: &str = "mcp__taomni_permissions__permission_prompt";

/// Directories that CC must never access.
pub fn sensitive_deny_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".ssh"));
    }
    if let Some(config) = dirs::config_dir() {
        dirs.push(config.join("taomni"));
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deny_dirs() -> Vec<PathBuf> {
        vec![PathBuf::from("/home/u/.ssh"), PathBuf::from("/home/u/.config/taomni")]
    }

    fn deny_list(value: &serde_json::Value) -> Vec<String> {
        value["permissions"]["deny"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn no_custom_yields_deny_list_only() {
        let v = build_settings_value(None, &deny_dirs()).unwrap();
        assert_eq!(
            v["permissions"]["allow"].as_array().unwrap().len(),
            0,
            "allow defaults to empty"
        );
        let deny = deny_list(&v);
        assert!(deny.contains(&"/home/u/.ssh/**".to_string()));
        assert!(deny.contains(&"/home/u/.config/taomni/**".to_string()));
        // Nothing beyond the two safety patterns.
        assert_eq!(deny.len(), 2);
        // No stray top-level keys.
        assert_eq!(v.as_object().unwrap().keys().count(), 1);
    }

    #[test]
    fn empty_string_is_treated_as_no_custom() {
        let v = build_settings_value(Some("   "), &deny_dirs()).unwrap();
        assert_eq!(deny_list(&v).len(), 2);
    }

    #[test]
    fn custom_preserves_fields_and_unions_deny() {
        let custom = r#"{
            "env": { "ANTHROPIC_AUTH_TOKEN": "sk-x", "ANTHROPIC_BASE_URL": "https://x" },
            "enabledPlugins": { "code-simplifier@official": true },
            "permissions": { "allow": ["Bash", "Read"], "deny": ["/secret/**"] }
        }"#;
        let v = build_settings_value(Some(custom), &deny_dirs()).unwrap();

        // User fields preserved verbatim.
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-x");
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://x");
        assert_eq!(v["enabledPlugins"]["code-simplifier@official"], true);
        let allow: Vec<String> = v["permissions"]["allow"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        assert_eq!(allow, vec!["Bash", "Read"]);

        // Deny is the union of the user's entry + the mandatory safety denies.
        let deny = deny_list(&v);
        assert!(deny.contains(&"/secret/**".to_string()));
        assert!(deny.contains(&"/home/u/.ssh/**".to_string()));
        assert!(deny.contains(&"/home/u/.config/taomni/**".to_string()));
    }

    #[test]
    fn safety_deny_not_duplicated_when_already_present() {
        let custom = r#"{ "permissions": { "deny": ["/home/u/.ssh/**"] } }"#;
        let v = build_settings_value(Some(custom), &deny_dirs()).unwrap();
        let count = deny_list(&v)
            .iter()
            .filter(|d| *d == "/home/u/.ssh/**")
            .count();
        assert_eq!(count, 1, "existing safety deny must not be duplicated");
    }

    #[test]
    fn invalid_json_errors() {
        assert!(build_settings_value(Some("{not json"), &deny_dirs()).is_err());
    }

    #[test]
    fn non_object_root_errors() {
        assert!(build_settings_value(Some("[1,2,3]"), &deny_dirs()).is_err());
        assert!(build_settings_value(Some("\"a string\""), &deny_dirs()).is_err());
    }

    #[test]
    fn non_object_permissions_errors() {
        let custom = r#"{ "permissions": "nope" }"#;
        assert!(build_settings_value(Some(custom), &deny_dirs()).is_err());
    }
}
