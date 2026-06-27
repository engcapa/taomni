use crate::state::AppState;
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub const DEFAULT_CODEX_MODEL: &str = "gpt-5.4";

#[derive(Debug, Clone, Default)]
pub struct CodexProfileRuntime {
    pub config: Map<String, Value>,
    pub env: HashMap<String, String>,
    pub isolated_home: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexCustomConfigProfile {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub vault_ref: String,
    pub created_at: u64,
    /// inherit | none | session | manual. Inherit means fall back to the
    /// bridge-level proxy setting.
    #[serde(default = "default_profile_proxy_mode")]
    pub proxy_mode: String,
    #[serde(default)]
    pub proxy_session_id: Option<String>,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexBridgeConfig {
    pub enabled: bool,
    /// "auto" = locate via PATH; or absolute path to binary.
    pub binary: String,
    pub min_version: String,
    /// Default model sent to Codex when a chat thread does not override it.
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
    /// none | session | manual. `proxy_url` is used for manual mode.
    #[serde(default = "default_global_proxy_mode")]
    pub proxy_mode: String,
    #[serde(default)]
    pub proxy_session_id: Option<String>,
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

fn default_global_proxy_mode() -> String {
    "none".into()
}

fn default_profile_proxy_mode() -> String {
    "inherit".into()
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
            proxy_mode: default_global_proxy_mode(),
            proxy_session_id: None,
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
        self.proxy_session_id = self
            .proxy_session_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        self.proxy_mode = normalize_global_proxy_mode(&self.proxy_mode);
        if self.proxy_url.is_some() && self.proxy_mode == "none" {
            // Migration path for configs written before proxy_mode existed.
            self.proxy_mode = "manual".into();
        }
        for profile in &mut self.custom_config_profiles {
            profile.proxy_url = profile
                .proxy_url
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            profile.proxy_session_id = profile
                .proxy_session_id
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            profile.proxy_mode = normalize_profile_proxy_mode(&profile.proxy_mode);
            if profile.proxy_url.is_some() && profile.proxy_mode == "inherit" {
                // Migration path for older profile records that only stored a
                // URL. Treat it as a profile-level manual proxy.
                profile.proxy_mode = "manual".into();
            }
        }
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

pub fn normalize_global_proxy_mode(mode: &str) -> String {
    match mode.trim() {
        "session" | "manual" => mode.trim().into(),
        _ => "none".into(),
    }
}

pub fn normalize_profile_proxy_mode(mode: &str) -> String {
    match mode.trim() {
        "none" | "session" | "manual" => mode.trim().into(),
        _ => "inherit".into(),
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

pub fn resolve_custom_runtime(
    cfg: &CodexBridgeConfig,
    vault: &Vault,
) -> Result<CodexProfileRuntime, String> {
    let Some(custom) = resolve_custom_config(cfg, vault)? else {
        return Ok(CodexProfileRuntime::default());
    };
    let mut runtime = parse_profile_config(Some(&custom))?;
    runtime.isolated_home = true;
    Ok(runtime)
}

fn active_enabled_profile(cfg: &CodexBridgeConfig) -> Option<&CodexCustomConfigProfile> {
    let active_id = cfg.active_profile_id.as_ref()?;
    cfg.custom_config_profiles
        .iter()
        .find(|p| &p.id == active_id && p.enabled)
}

fn resolve_profile_proxy_source(
    state: &AppState,
    mode: &str,
    session_id: Option<&str>,
    url: Option<&str>,
) -> Result<Option<Option<String>>, String> {
    match normalize_profile_proxy_mode(mode).as_str() {
        "none" => Ok(Some(None)),
        "session" => {
            let Some(id) = session_id.map(str::trim).filter(|s| !s.is_empty()) else {
                return Ok(None);
            };
            let proxy = crate::proxy::resolve_session_proxy(state, id)?;
            Ok(Some(proxy.map(|p| p.to_url())))
        }
        "manual" => {
            let Some(proxy_url) = url.map(str::trim).filter(|s| !s.is_empty()) else {
                return Ok(None);
            };
            Ok(Some(Some(proxy_url.to_string())))
        }
        _ => Ok(None),
    }
}

fn resolve_global_proxy_source(
    state: &AppState,
    mode: &str,
    session_id: Option<&str>,
    url: Option<&str>,
) -> Result<Option<String>, String> {
    match normalize_global_proxy_mode(mode).as_str() {
        "session" => {
            let Some(id) = session_id.map(str::trim).filter(|s| !s.is_empty()) else {
                return Ok(None);
            };
            Ok(crate::proxy::resolve_session_proxy(state, id)?.map(|p| p.to_url()))
        }
        "manual" => Ok(url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)),
        _ => Ok(None),
    }
}

pub fn resolve_global_proxy_url(
    state: &AppState,
    cfg: &CodexBridgeConfig,
) -> Result<Option<String>, String> {
    resolve_global_proxy_source(
        state,
        &cfg.proxy_mode,
        cfg.proxy_session_id.as_deref(),
        cfg.proxy_url.as_deref(),
    )
}

pub fn resolve_effective_proxy_url(
    state: &AppState,
    cfg: &CodexBridgeConfig,
) -> Result<Option<String>, String> {
    if let Some(profile) = active_enabled_profile(cfg) {
        if let Some(profile_choice) = resolve_profile_proxy_source(
            state,
            &profile.proxy_mode,
            profile.proxy_session_id.as_deref(),
            profile.proxy_url.as_deref(),
        )? {
            return Ok(profile_choice);
        }
    }
    resolve_global_proxy_url(state, cfg)
}

pub fn resolve_effective_proxy_url_with_profile_override(
    state: &AppState,
    cfg: &CodexBridgeConfig,
    proxy_mode: Option<&str>,
    proxy_session_id: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(mode) = proxy_mode {
        if let Some(profile_choice) =
            resolve_profile_proxy_source(state, mode, proxy_session_id, proxy_url)?
        {
            return Ok(profile_choice);
        }
    }
    resolve_global_proxy_source(
        state,
        &cfg.proxy_mode,
        cfg.proxy_session_id.as_deref(),
        cfg.proxy_url.as_deref(),
    )
}

pub fn parse_profile_config(custom: Option<&str>) -> Result<CodexProfileRuntime, String> {
    match custom {
        Some(s) if !s.trim().is_empty() => parse_profile_config_text(s),
        _ => Ok(CodexProfileRuntime::default()),
    }
}

fn parse_profile_config_text(text: &str) -> Result<CodexProfileRuntime, String> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        return parse_legacy_json_profile_config(trimmed);
    }
    parse_toml_profile_config(trimmed)
}

fn parse_legacy_json_profile_config(text: &str) -> Result<CodexProfileRuntime, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| format!("Invalid legacy Codex config JSON: {e}"))?;
    let mut config = value
        .as_object()
        .cloned()
        .ok_or_else(|| "Codex config must be a JSON object".to_string())?;
    let env = extract_json_env(&mut config)?;
    Ok(CodexProfileRuntime {
        config,
        env,
        isolated_home: false,
    })
}

fn parse_toml_profile_config(text: &str) -> Result<CodexProfileRuntime, String> {
    let value: toml::Value =
        toml::from_str(text).map_err(|e| format!("Invalid Codex profile TOML: {e}"))?;
    let mut table = match value {
        toml::Value::Table(table) => table,
        _ => return Err("Codex profile TOML must be a table".into()),
    };

    let mut env = HashMap::new();
    extract_top_level_env_keys(&mut table, &mut env)?;
    if let Some(env_value) = table.remove("env") {
        extract_toml_env_table("env", env_value, &mut env)?;
    }
    let remove_taomni = match table.get_mut("taomni") {
        Some(toml::Value::Table(taomni)) => {
            if let Some(env_value) = taomni.remove("env") {
                extract_toml_env_table("taomni.env", env_value, &mut env)?;
            }
            taomni.is_empty()
        }
        Some(_) => false,
        None => false,
    };
    if remove_taomni {
        table.remove("taomni");
    }

    let config_value = serde_json::to_value(toml::Value::Table(table))
        .map_err(|e| format!("Failed to convert Codex profile TOML: {e}"))?;
    let config = config_value
        .as_object()
        .cloned()
        .ok_or_else(|| "Codex profile TOML must produce a config object".to_string())?;
    Ok(CodexProfileRuntime {
        config,
        env,
        isolated_home: false,
    })
}

fn extract_json_env(config: &mut Map<String, Value>) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::new();
    extract_json_top_level_env_keys(config, &mut env)?;
    if let Some(value) = config.remove("env") {
        let obj = value
            .as_object()
            .ok_or_else(|| "Codex profile `env` must be an object".to_string())?;
        for (key, value) in obj {
            let Some(value) = value.as_str() else {
                return Err(format!("Codex profile env `{key}` must be a string"));
            };
            insert_env_value(&mut env, key, value);
        }
    }
    if let Some(Value::Object(taomni)) = config.get_mut("taomni") {
        if let Some(value) = taomni.remove("env") {
            let obj = value
                .as_object()
                .ok_or_else(|| "Codex profile `taomni.env` must be an object".to_string())?;
            for (key, value) in obj {
                let Some(value) = value.as_str() else {
                    return Err(format!("Codex profile taomni.env `{key}` must be a string"));
                };
                insert_env_value(&mut env, key, value);
            }
        }
        if taomni.is_empty() {
            config.remove("taomni");
        }
    }
    Ok(env)
}

fn extract_json_top_level_env_keys(
    config: &mut Map<String, Value>,
    env: &mut HashMap<String, String>,
) -> Result<(), String> {
    let keys = config
        .iter()
        .filter_map(|(key, _)| {
            if is_env_key(key) {
                Some(key.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for key in keys {
        let value = config.remove(&key).unwrap_or(Value::Null);
        let Some(value) = value.as_str() else {
            return Err(format!("Codex profile env `{key}` must be a string"));
        };
        insert_env_value(env, &key, value);
    }
    Ok(())
}

fn extract_top_level_env_keys(
    table: &mut toml::Table,
    env: &mut HashMap<String, String>,
) -> Result<(), String> {
    let keys = table
        .iter()
        .filter_map(|(key, _)| {
            if is_env_key(key) {
                Some(key.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for key in keys {
        let value = table
            .remove(&key)
            .unwrap_or_else(|| toml::Value::String(String::new()));
        let Some(value) = value.as_str() else {
            return Err(format!("Codex profile env `{key}` must be a string"));
        };
        insert_env_value(env, &key, value);
    }
    Ok(())
}

fn extract_toml_env_table(
    section: &str,
    value: toml::Value,
    env: &mut HashMap<String, String>,
) -> Result<(), String> {
    let toml::Value::Table(table) = value else {
        return Err(format!("Codex profile [{section}] must be a table"));
    };
    for (key, value) in table {
        let Some(value) = value.as_str() else {
            return Err(format!("Codex profile [{section}].{key} must be a string"));
        };
        insert_env_value(env, &key, value);
    }
    Ok(())
}

fn insert_env_value(env: &mut HashMap<String, String>, key: &str, value: &str) {
    let key = key.trim();
    let value = value.trim();
    if !key.is_empty() && !value.is_empty() {
        env.insert(key.to_string(), value.to_string());
    }
}

fn is_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_uppercase() || first == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

pub fn build_config_value(custom: Option<&str>) -> Result<Map<String, Value>, String> {
    Ok(parse_profile_config(custom)?.config)
}

pub fn build_thread_config_from_config(
    mut root: Map<String, Value>,
    server_name: &str,
    server_url: &str,
    token: &str,
    control_server_url: &str,
) -> Map<String, Value> {
    insert_mcp_server(&mut root, server_name, server_url, token);
    insert_mcp_server(&mut root, "taomni_control", control_server_url, token);
    root
}

fn insert_mcp_server(
    root: &mut Map<String, Value>,
    server_name: &str,
    server_url: &str,
    token: &str,
) {
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
    control_server_url: &str,
) -> Result<Map<String, Value>, String> {
    Ok(build_thread_config_from_config(
        build_config_value(custom)?,
        server_name,
        server_url,
        token,
        control_server_url,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_used_when_empty() {
        assert_eq!(normalize_model_name(""), DEFAULT_CODEX_MODEL);
        assert_eq!(normalize_model_name(" gpt-5 "), "gpt-5");
    }

    #[test]
    fn proxy_modes_normalize_and_migrate_old_urls() {
        let mut cfg = CodexBridgeConfig {
            proxy_url: Some(" http://127.0.0.1:31028 ".into()),
            ..CodexBridgeConfig::default()
        };
        cfg.custom_config_profiles.push(CodexCustomConfigProfile {
            id: "p1".into(),
            name: "Profile".into(),
            enabled: true,
            vault_ref: String::new(),
            created_at: 1,
            proxy_mode: "inherit".into(),
            proxy_session_id: None,
            proxy_url: Some(" socks5://127.0.0.1:1080 ".into()),
        });
        cfg.normalize();
        assert_eq!(cfg.proxy_mode, "manual");
        assert_eq!(cfg.proxy_url.as_deref(), Some("http://127.0.0.1:31028"));
        assert_eq!(cfg.custom_config_profiles[0].proxy_mode, "manual");
        assert_eq!(
            cfg.custom_config_profiles[0].proxy_url.as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
    }

    #[test]
    fn custom_config_must_be_object() {
        assert!(build_config_value(Some("[]")).is_err());
        assert!(build_config_value(Some(r#"{"model":"gpt-5"}"#)).is_ok());
    }

    #[test]
    fn toml_profile_extracts_env_and_config() {
        let runtime = parse_profile_config(Some(
            r#"
model = "gpt-5.4"
model_provider = "my-provider"
OPENAI_API_KEY = "sk-test"

[model_providers.my-provider]
name = "OpenAI API key"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"

[env]
EXAMPLE_FEATURES = "on"
"#,
        ))
        .unwrap();
        assert_eq!(
            runtime.config.get("model").and_then(Value::as_str),
            Some("gpt-5.4")
        );
        assert!(runtime.config.get("OPENAI_API_KEY").is_none());
        assert!(runtime.config.get("env").is_none());
        assert_eq!(
            runtime.env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-test")
        );
        assert_eq!(
            runtime.env.get("EXAMPLE_FEATURES").map(String::as_str),
            Some("on")
        );
    }

    #[test]
    fn thread_config_forces_mcp_server() {
        let cfg = build_thread_config(
            Some(r#"{"model":"gpt-5"}"#),
            "taomni",
            "http://127.0.0.1:1/mcp",
            "tok",
            "http://127.0.0.1:1/mcp/control",
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
        assert_eq!(
            cfg.get("mcp_servers.taomni_control.url")
                .and_then(Value::as_str),
            Some("http://127.0.0.1:1/mcp/control")
        );
        assert_eq!(
            cfg.get("mcp_servers.taomni_control.default_tools_approval_mode")
                .and_then(Value::as_str),
            Some("approve")
        );
    }
}
