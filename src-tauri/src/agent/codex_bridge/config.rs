use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const DEFAULT_CODEX_MODEL: &str = "auto";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexCustomConfigProfile {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub vault_ref: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexBridgeConfig {
    pub enabled: bool,
    /// "auto" = locate via PATH; or absolute path to binary.
    pub binary: String,
    pub min_version: String,
    /// "auto" lets the Codex CLI choose its configured default.
    pub default_model: String,
    /// Codex app-server `SandboxMode`: read-only | workspace-write | danger-full-access.
    pub sandbox: String,
    /// Codex approval policy: never | on-request | on-failure | untrusted.
    pub approval_policy: String,
    /// Allow network inside Codex's sandbox policy for this turn.
    #[serde(default)]
    pub network_access: bool,
    /// Optional proxy URL applied to Codex CLI child processes.
    #[serde(default)]
    pub proxy_url: Option<String>,
    /// Same behavior as the Claude bridge for Taomni MCP permission cards.
    #[serde(default)]
    pub confirm_readonly: bool,
    /// Mirror finished captured runs into the bound terminal as display-only traces.
    #[serde(default = "default_terminal_echo_enabled")]
    pub terminal_echo_enabled: bool,
    #[serde(default)]
    pub custom_config_profiles: Vec<CodexCustomConfigProfile>,
    #[serde(default)]
    pub active_profile_id: Option<String>,
}

fn default_terminal_echo_enabled() -> bool {
    true
}

impl Default for CodexBridgeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            binary: "auto".into(),
            min_version: super::MIN_VERSION.into(),
            default_model: DEFAULT_CODEX_MODEL.into(),
            sandbox: "read-only".into(),
            approval_policy: "never".into(),
            network_access: false,
            proxy_url: None,
            confirm_readonly: false,
            terminal_echo_enabled: true,
            custom_config_profiles: Vec::new(),
            active_profile_id: None,
        }
    }
}

impl CodexBridgeConfig {
    pub fn normalize(&mut self) {
        self.default_model = normalize_model_name(&self.default_model);
        self.sandbox = normalize_sandbox(&self.sandbox);
        self.approval_policy = normalize_approval_policy(&self.approval_policy);
        self.proxy_url = self
            .proxy_url
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }
}

pub fn normalize_model_name(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        DEFAULT_CODEX_MODEL.into()
    } else {
        trimmed.into()
    }
}

pub fn normalize_sandbox(sandbox: &str) -> String {
    match sandbox.trim() {
        "workspace-write" | "danger-full-access" => sandbox.trim().into(),
        _ => "read-only".into(),
    }
}

pub fn normalize_approval_policy(policy: &str) -> String {
    match policy.trim() {
        "on-request" | "on-failure" | "untrusted" => policy.trim().into(),
        _ => "never".into(),
    }
}

fn resolve_vault_ref(reference: &str, vault: &Vault) -> Result<Option<String>, String> {
    match vault.resolve(reference) {
        Ok(Some(plaintext)) => Ok(Some(plaintext.to_string())),
        Ok(None) => Ok(Some(reference.to_string())),
        Err(e) if e.contains(crate::vault::ERR_VAULT_LOCKED) => Err(format!(
            "{}: unlock the credential vault to use your custom Codex config.",
            crate::vault::ERR_VAULT_LOCKED
        )),
        Err(e) => Err(e),
    }
}

pub fn resolve_custom_config(
    cfg: &CodexBridgeConfig,
    vault: &Vault,
) -> Result<Option<String>, String> {
    let active_id = match cfg.active_profile_id.as_ref() {
        Some(id) => id,
        None => return Ok(None),
    };
    let profile = match cfg
        .custom_config_profiles
        .iter()
        .find(|p| &p.id == active_id)
    {
        Some(p) => p,
        None => return Ok(None),
    };
    if !profile.enabled {
        return Ok(None);
    }
    resolve_vault_ref(&profile.vault_ref, vault)
}

pub fn build_config_value(custom: Option<&str>) -> Result<Map<String, Value>, String> {
    match custom {
        Some(s) if !s.trim().is_empty() => {
            let value: Value = serde_json::from_str(s)
                .map_err(|e| format!("Invalid custom Codex config JSON: {e}"))?;
            value
                .as_object()
                .cloned()
                .ok_or_else(|| "Codex config must be a JSON object".to_string())
        }
        _ => Ok(Map::new()),
    }
}

/// Build app-server `thread/start.config` overrides.
///
/// Codex accepts JSON config overrides on app-server thread creation. We use
/// dotted keys here because they match the CLI `-c key=value` surface verified
/// by the P0 probes and let us force one scoped Taomni MCP server per thread.
pub fn build_thread_config(
    custom: Option<&str>,
    server_name: &str,
    server_url: &str,
    token: &str,
) -> Result<Map<String, Value>, String> {
    let mut root = build_config_value(custom)?;
    let prefix = format!("mcp_servers.{server_name}");
    root.insert(format!("{prefix}.url"), Value::String(server_url.into()));
    root.insert(
        format!("{prefix}.http_headers"),
        serde_json::json!({ "Authorization": format!("Bearer {token}") }),
    );
    root.insert(format!("{prefix}.required"), Value::Bool(true));
    root.insert(
        format!("{prefix}.default_tools_approval_mode"),
        Value::String("approve".into()),
    );
    root.insert(
        format!("{prefix}.startup_timeout_sec"),
        Value::Number(10.into()),
    );
    root.insert(
        format!("{prefix}.tool_timeout_sec"),
        Value::Number(600.into()),
    );
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_auto_when_empty() {
        assert_eq!(normalize_model_name(""), "auto");
        assert_eq!(normalize_model_name(" gpt-5 "), "gpt-5");
    }

    #[test]
    fn custom_config_must_be_object() {
        assert!(build_config_value(Some("[]")).is_err());
        assert!(build_config_value(Some(r#"{"model":"gpt-5"}"#)).is_ok());
    }

    #[test]
    fn thread_config_forces_mcp_server() {
        let cfg = build_thread_config(
            Some(r#"{"model":"gpt-5"}"#),
            "taomni",
            "http://127.0.0.1:1/mcp",
            "tok",
        )
        .unwrap();
        assert_eq!(cfg.get("model").and_then(Value::as_str), Some("gpt-5"));
        assert_eq!(
            cfg.get("mcp_servers.taomni.url").and_then(Value::as_str),
            Some("http://127.0.0.1:1/mcp")
        );
        assert_eq!(
            cfg.get("mcp_servers.taomni.default_tools_approval_mode")
                .and_then(Value::as_str),
            Some("approve")
        );
    }
}
