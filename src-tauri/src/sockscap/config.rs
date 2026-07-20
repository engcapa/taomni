//! Persisted SocksCap configuration.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ScopeMode {
    #[default]
    Global,
    Apps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RuleMode {
    /// GFWList match → Proxy; miss → [`SocksCapConfig::default_action`].
    #[default]
    GfwList,
    /// Everything except hard-bypass / user Direct → Proxy.
    ProxyAll,
    /// Only user rules + bypass; no GFWList.
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    #[default]
    Direct,
    Proxy,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpstreamKind {
    Http,
    Socks5,
    Ssh,
}

impl Default for UpstreamKind {
    fn default() -> Self {
        Self::Http
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamRef {
    pub kind: UpstreamKind,
    /// When set, resolve host/port/auth from a saved Proxy or SSH session.
    #[serde(default)]
    pub session_id: String,
    /// Manual fields (used when `session_id` is empty).
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// `vault:<id>` only — never plaintext on disk.
    #[serde(default)]
    pub password_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSelector {
    /// Absolute or normalized executable path (Windows/Linux).
    #[serde(default)]
    pub path: String,
    /// macOS bundle id when available.
    #[serde(default)]
    pub bundle_id: String,
    /// Display name for the UI.
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserRuleAction {
    Direct,
    Proxy,
    Block,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRule {
    /// Domain suffix (e.g. `example.com`), CIDR (`10.0.0.0/8`), or exact host.
    pub pattern: String,
    pub action: UserRuleAction,
    #[serde(default)]
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfwListSource {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_gfwlist_url")]
    pub url: String,
    /// 0 = manual only.
    #[serde(default = "default_refresh_hours")]
    pub auto_refresh_hours: u32,
}

fn default_true() -> bool {
    true
}

fn default_gfwlist_url() -> String {
    // Common public mirror; users can override. Not fetched at build time.
    "https://cdn.jsdelivr.net/gh/gfwlist/gfwlist/gfwlist.txt".into()
}

fn default_refresh_hours() -> u32 {
    24
}

impl Default for GfwListSource {
    fn default() -> Self {
        Self {
            enabled: true,
            url: default_gfwlist_url(),
            auto_refresh_hours: default_refresh_hours(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksCapConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: ScopeMode,
    #[serde(default)]
    pub apps: Vec<AppSelector>,
    #[serde(default)]
    pub upstream: UpstreamRef,
    #[serde(default)]
    pub rule_mode: RuleMode,
    #[serde(default)]
    pub gfwlist: GfwListSource,
    #[serde(default)]
    pub user_rules: Vec<UserRule>,
    #[serde(default = "default_bypass_cidrs")]
    pub bypass_cidrs: Vec<String>,
    #[serde(default)]
    pub default_action: Decision,
    #[serde(default)]
    pub restore_on_login: bool,
}

fn default_bypass_cidrs() -> Vec<String> {
    vec![
        "127.0.0.0/8".into(),
        "10.0.0.0/8".into(),
        "172.16.0.0/12".into(),
        "192.168.0.0/16".into(),
        "::1/128".into(),
        "fc00::/7".into(),
        "fe80::/10".into(),
    ]
}

impl Default for SocksCapConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: ScopeMode::Global,
            apps: Vec::new(),
            upstream: UpstreamRef::default(),
            rule_mode: RuleMode::GfwList,
            gfwlist: GfwListSource::default(),
            user_rules: Vec::new(),
            bypass_cidrs: default_bypass_cidrs(),
            default_action: Decision::Direct,
            restore_on_login: false,
        }
    }
}

impl SocksCapConfig {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    pub fn validate(&self) -> Result<(), String> {
        if matches!(self.mode, ScopeMode::Apps) && self.apps.is_empty() {
            return Err("App mode requires at least one application".into());
        }
        if self.upstream.session_id.trim().is_empty() {
            if self.upstream.host.trim().is_empty() {
                return Err("Upstream host is empty (set a session or manual host)".into());
            }
            if self.upstream.port == 0 {
                return Err("Upstream port must be > 0".into());
            }
        }
        Ok(())
    }

    /// Stable hash of config content for recovery journals.
    pub fn content_hash(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        let dig = Sha256::digest(&bytes);
        hex::encode(&dig[..8])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_roundtrip() {
        let c = SocksCapConfig::default();
        let j = serde_json::to_string(&c).unwrap();
        let back: SocksCapConfig = serde_json::from_str(&j).unwrap();
        assert!(matches!(back.rule_mode, RuleMode::GfwList));
        assert!(!back.bypass_cidrs.is_empty());
    }

    #[test]
    fn validate_apps_empty() {
        let mut c = SocksCapConfig::default();
        c.mode = ScopeMode::Apps;
        c.upstream.host = "127.0.0.1".into();
        c.upstream.port = 1080;
        assert!(c.validate().is_err());
    }
}
