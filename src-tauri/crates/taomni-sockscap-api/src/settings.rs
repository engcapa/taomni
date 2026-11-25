use super::applications::AppSelector;
use super::gfwlist::GfwListSource;
use super::gfwlist::default_true;
use super::rules::SocksCapProfile;
use super::rules::UserRule;
use super::scope::Decision;
use super::scope::RuleMode;
use super::scope::ScopeMode;
use super::upstream::UpstreamRef;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::path::Path;

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
    /// Drop outbound UDP 443 for in-scope flows so QUIC/HTTP3 falls back to TCP,
    /// which the capture path can attribute (SNI) and proxy. Without this, QUIC
    /// bypasses capture entirely (Windows filter is TCP-only, Linux redirect is
    /// TCP-only) and leaks the real client IP — breaking geo-restricted sites
    /// that the TCP path would have routed through the upstream. Session-level,
    /// shared by all capture backends. Default on. See
    /// claudedocs/sockscap-quic-block-design.md.
    #[serde(default = "default_true")]
    pub block_quic: bool,
}

pub(super) fn default_bypass_cidrs() -> Vec<String> {
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
            block_quic: default_true(),
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
            || !self
                .profiles
                .iter()
                .any(|p| p.id == self.selected_profile_id)
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

    pub fn requires_gfwlist(&self) -> bool {
        self.active_profiles()
            .iter()
            .any(|profile| matches!(profile.rule_mode, RuleMode::GfwList))
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
        for profile in &self.profiles {
            for app in &profile.apps {
                app.launch_preparation.validate(&profile.name, &app.path)?;
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
