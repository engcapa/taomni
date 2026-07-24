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
pub struct SocksCapProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub mode: ScopeMode,
    #[serde(default)]
    pub apps: Vec<AppSelector>,
    #[serde(default)]
    pub upstream: UpstreamRef,
    #[serde(default)]
    pub rule_mode: RuleMode,
    #[serde(default)]
    pub user_rules: Vec<UserRule>,
    #[serde(default)]
    pub default_action: Decision,
}

impl Default for SocksCapProfile {
    fn default() -> Self {
        Self {
            id: "default".into(),
            name: "默认方案".into(),
            icon: Some("🎮".into()),
            color: None,
            enabled: true,
            priority: 0,
            mode: ScopeMode::Global,
            apps: Vec::new(),
            upstream: UpstreamRef::default(),
            rule_mode: RuleMode::GfwList,
            user_rules: Vec::new(),
            default_action: Decision::Direct,
        }
    }
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
    pub active_profile_ids: Vec<String>,
    #[serde(default)]
    pub selected_profile_id: String,
    #[serde(default)]
    pub profiles: Vec<SocksCapProfile>,

    // Legacy fields kept for backward compatibility when deserializing old configs
    #[serde(default)]
    pub mode: ScopeMode,
    #[serde(default)]
    pub apps: Vec<AppSelector>,
    #[serde(default)]
    pub upstream: UpstreamRef,
    #[serde(default)]
    pub rule_mode: RuleMode,
    #[serde(default)]
    pub user_rules: Vec<UserRule>,
    #[serde(default)]
    pub default_action: Decision,

    // Global shared fields
    #[serde(default)]
    pub gfwlist: GfwListSource,
    #[serde(default = "default_bypass_cidrs")]
    pub bypass_cidrs: Vec<String>,
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
        let mut cfg = Self {
            enabled: false,
            active_profile_ids: Vec::new(),
            selected_profile_id: String::new(),
            profiles: Vec::new(),
            mode: ScopeMode::Global,
            apps: Vec::new(),
            upstream: UpstreamRef::default(),
            rule_mode: RuleMode::GfwList,
            gfwlist: GfwListSource::default(),
            user_rules: Vec::new(),
            bypass_cidrs: default_bypass_cidrs(),
            default_action: Decision::Direct,
            restore_on_login: false,
        };
        cfg.normalize();
        cfg
    }
}

impl SocksCapConfig {
    pub fn normalize(&mut self) {
        if self.profiles.is_empty() {
            let default_profile = SocksCapProfile {
                id: "default".into(),
                name: "默认方案".into(),
                icon: Some("🎮".into()),
                color: None,
                enabled: true,
                priority: 0,
                mode: self.mode,
                apps: self.apps.clone(),
                upstream: self.upstream.clone(),
                rule_mode: self.rule_mode,
                user_rules: self.user_rules.clone(),
                default_action: self.default_action,
            };
            self.profiles.push(default_profile);
        }
        if self.active_profile_ids.is_empty() {
            if let Some(first) = self.profiles.first() {
                self.active_profile_ids.push(first.id.clone());
            }
        }
        if self.selected_profile_id.is_empty()
            || !self.profiles.iter().any(|p| p.id == self.selected_profile_id)
        {
            if let Some(first) = self.profiles.first() {
                self.selected_profile_id = first.id.clone();
            }
        }
        if let Some(selected) = self
            .profiles
            .iter()
            .find(|p| p.id == self.selected_profile_id)
            .or_else(|| self.profiles.first())
        {
            self.mode = selected.mode;
            self.apps = selected.apps.clone();
            self.upstream = selected.upstream.clone();
            self.rule_mode = selected.rule_mode;
            self.user_rules = selected.user_rules.clone();
            self.default_action = selected.default_action;
        }
    }

    pub fn load(path: &Path) -> Self {
        let mut cfg: Self = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        cfg.normalize();
        cfg
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let mut clone = self.clone();
        clone.normalize();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&clone).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    pub fn active_profiles(&self) -> Vec<&SocksCapProfile> {
        let mut list: Vec<&SocksCapProfile> = self
            .profiles
            .iter()
            .filter(|p| p.enabled && self.active_profile_ids.contains(&p.id))
            .collect();
        list.sort_by_key(|p| p.priority);
        list
    }

    pub fn validate(&self) -> Result<(), String> {
        let active = self.active_profiles();
        if active.is_empty() {
            return Err("At least one profile must be enabled and active".into());
        }
        for prof in active {
            if matches!(prof.mode, ScopeMode::Apps) && prof.apps.is_empty() {
                return Err(format!(
                    "Profile '{}' is in App mode but has no applications specified",
                    prof.name
                ));
            }
            if prof.upstream.session_id.trim().is_empty() {
                if prof.upstream.host.trim().is_empty() {
                    return Err(format!(
                        "Profile '{}' upstream host is empty (set a session or manual host)",
                        prof.name
                    ));
                }
                if prof.upstream.port == 0 {
                    return Err(format!("Profile '{}' upstream port must be > 0", prof.name));
                }
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
        let mut back: SocksCapConfig = serde_json::from_str(&j).unwrap();
        back.normalize();
        assert!(matches!(back.rule_mode, RuleMode::GfwList));
        assert!(!back.bypass_cidrs.is_empty());
        assert_eq!(back.profiles.len(), 1);
        assert_eq!(back.active_profile_ids, vec!["default"]);
    }

    #[test]
    fn validate_apps_empty() {
        let mut c = SocksCapConfig::default();
        c.profiles[0].mode = ScopeMode::Apps;
        c.profiles[0].upstream.host = "127.0.0.1".into();
        c.profiles[0].upstream.port = 1080;
        assert!(c.validate().is_err());
    }

    #[test]
    fn legacy_config_migration() {
        let legacy_json = r#"{
            "enabled": true,
            "mode": "apps",
            "apps": [{"path": "C:\\game.exe", "name": "Game"}],
            "upstream": {"kind": "socks5", "host": "1.2.3.4", "port": 1080},
            "ruleMode": "proxyAll"
        }"#;
        let mut loaded: SocksCapConfig = serde_json::from_str(legacy_json).unwrap();
        loaded.normalize();
        assert_eq!(loaded.profiles.len(), 1);
        assert_eq!(loaded.profiles[0].mode, ScopeMode::Apps);
        assert_eq!(loaded.profiles[0].apps.len(), 1);
        assert_eq!(loaded.profiles[0].upstream.host, "1.2.3.4");
        assert_eq!(loaded.profiles[0].rule_mode, RuleMode::ProxyAll);
        assert!(loaded.validate().is_ok());
    }
}

