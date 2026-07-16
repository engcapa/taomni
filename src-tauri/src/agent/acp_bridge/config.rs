use super::process::AcpProcessConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

pub const ACP_PROVIDER_PREFIX: &str = "acp:";
pub const DEFAULT_REQUEST_TIMEOUT_SECONDS: u64 = 120;
const MAX_REQUEST_TIMEOUT_SECONDS: u64 = 600;
const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];
const NO_PROXY_ENV_KEYS: [&str; 2] = ["NO_PROXY", "no_proxy"];
const LOOPBACK_NO_PROXY: &str = "localhost,127.0.0.1,::1";

/// Optional local-media abilities exposed by an ACP profile. ACP itself does
/// not negotiate generation abilities, so these are explicit profile metadata
/// rather than inferred from an agent's protocol handshake.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct AcpProfileCapabilities {
    /// `None` means the capability was not present in an older saved profile.
    /// That lets the built-in Grok preset retain its compatibility default
    /// without making an explicit `false` indistinguishable from an omission.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_generation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_generation: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AcpProfileConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub command: String,
    pub args: Vec<String>,
    pub capabilities: AcpProfileCapabilities,
    /// Optional ACP authentication method advertised by the local CLI. No
    /// credential value is transported or persisted by this profile.
    pub auth_method_id: Option<String>,
    /// inherit | direct | app | session | manual
    pub proxy_mode: String,
    pub proxy_session_id: Option<String>,
    pub proxy_url: Option<String>,
}

impl Default for AcpProfileConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: false,
            command: String::new(),
            args: Vec::new(),
            capabilities: AcpProfileCapabilities::default(),
            auth_method_id: None,
            proxy_mode: default_profile_proxy_mode(),
            proxy_session_id: None,
            proxy_url: None,
        }
    }
}

impl AcpProfileConfig {
    fn normalize(&mut self, fallback_index: usize) {
        self.id = normalize_profile_id(&self.id, fallback_index);
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            self.name = self.id.clone();
        }
        self.command = self.command.trim().to_string();
        self.auth_method_id = normalize_optional(&self.auth_method_id);
        self.proxy_session_id = normalize_optional(&self.proxy_session_id);
        self.proxy_url = normalize_optional(&self.proxy_url);
        self.proxy_mode = normalize_profile_proxy_mode(&self.proxy_mode);
        if self.proxy_url.is_some() && self.proxy_mode == "inherit" {
            self.proxy_mode = "manual".into();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AcpBridgeConfig {
    pub enabled: bool,
    pub active_profile_id: Option<String>,
    /// direct | app | session | manual
    pub proxy_mode: String,
    pub proxy_session_id: Option<String>,
    pub proxy_url: Option<String>,
    pub request_timeout_seconds: u64,
    pub profiles: Vec<AcpProfileConfig>,
}

impl Default for AcpBridgeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            active_profile_id: Some(super::presets::GROK_PROFILE_ID.into()),
            proxy_mode: default_global_proxy_mode(),
            proxy_session_id: None,
            proxy_url: None,
            request_timeout_seconds: DEFAULT_REQUEST_TIMEOUT_SECONDS,
            profiles: vec![super::presets::grok_profile()],
        }
    }
}

impl AcpBridgeConfig {
    pub fn normalize(&mut self) {
        self.proxy_session_id = normalize_optional(&self.proxy_session_id);
        self.proxy_url = normalize_optional(&self.proxy_url);
        self.proxy_mode = normalize_global_proxy_mode(&self.proxy_mode);
        if self.proxy_url.is_some() && self.proxy_mode == "direct" {
            self.proxy_mode = "manual".into();
        }
        self.request_timeout_seconds = self
            .request_timeout_seconds
            .clamp(1, MAX_REQUEST_TIMEOUT_SECONDS);

        let mut ids = HashSet::new();
        for (index, profile) in self.profiles.iter_mut().enumerate() {
            profile.normalize(index + 1);
            let base = profile.id.clone();
            let mut suffix = 2;
            while !ids.insert(profile.id.clone()) {
                profile.id = format!("{base}-{suffix}");
                suffix += 1;
            }
        }

        self.active_profile_id = normalize_optional(&self.active_profile_id)
            .map(|id| normalize_profile_id(&id, 1))
            .filter(|id| self.profiles.iter().any(|profile| &profile.id == id));

        // The settings UI historically allowed the bridge master switch to
        // be enabled while every configured profile remained disabled. That
        // state makes the provider picker look as if ACP has disappeared even
        // though the user just enabled it. Treat the preferred configured
        // profile as enabled when migrating that contradictory state.
        if self.enabled && !self.profiles.iter().any(|profile| profile.enabled) {
            let preferred_index = self.active_profile_id.as_deref().and_then(|active_id| {
                self.profiles.iter().position(|profile| {
                    profile.id == active_id && !profile.command.trim().is_empty()
                })
            });
            let fallback_index = preferred_index.or_else(|| {
                self.profiles
                    .iter()
                    .position(|profile| !profile.command.trim().is_empty())
            });
            if let Some(index) = fallback_index {
                self.profiles[index].enabled = true;
                self.active_profile_id = Some(self.profiles[index].id.clone());
            }
        }
    }

    pub fn active_profile(&self) -> Option<&AcpProfileConfig> {
        let active_id = self.active_profile_id.as_deref()?;
        self.profiles
            .iter()
            .find(|profile| profile.id == active_id && profile.enabled)
    }

    pub fn profile(&self, profile_id: &str) -> Option<&AcpProfileConfig> {
        let profile_id = profile_id_from_provider_id(profile_id).unwrap_or(profile_id);
        self.profiles
            .iter()
            .find(|profile| profile.id == profile_id)
    }

    pub fn request_timeout(&self) -> Duration {
        Duration::from_secs(
            self.request_timeout_seconds
                .clamp(1, MAX_REQUEST_TIMEOUT_SECONDS),
        )
    }
}

impl AcpProfileConfig {
    pub fn supports_image_generation(&self) -> bool {
        self.id == super::presets::GROK_PROFILE_ID
            && self.capabilities.image_generation.unwrap_or(true)
    }

    pub fn supports_video_generation(&self) -> bool {
        self.id == super::presets::GROK_PROFILE_ID
            && self.capabilities.video_generation.unwrap_or(true)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpProxySource {
    Direct,
    App,
    Session(String),
    Manual(String),
}

pub fn provider_id_for_profile(profile_id: &str) -> String {
    format!("{ACP_PROVIDER_PREFIX}{profile_id}")
}

pub fn profile_id_from_provider_id(provider_id: &str) -> Option<&str> {
    provider_id
        .strip_prefix(ACP_PROVIDER_PREFIX)
        .filter(|profile_id| !profile_id.is_empty())
}

pub fn normalize_global_proxy_mode(mode: &str) -> String {
    match mode.trim() {
        "app" | "session" | "manual" => mode.trim().into(),
        // `none` is accepted as a migration alias used by the existing local
        // bridge configs. ACP persists the clearer `direct` spelling.
        _ => "direct".into(),
    }
}

pub fn normalize_profile_proxy_mode(mode: &str) -> String {
    match mode.trim() {
        "direct" | "app" | "session" | "manual" => mode.trim().into(),
        _ => "inherit".into(),
    }
}

pub fn effective_proxy_source(
    bridge: &AcpBridgeConfig,
    profile: &AcpProfileConfig,
) -> Result<AcpProxySource, String> {
    let mode = normalize_profile_proxy_mode(&profile.proxy_mode);
    if mode == "inherit" {
        proxy_source(
            &normalize_global_proxy_mode(&bridge.proxy_mode),
            bridge.proxy_session_id.as_deref(),
            bridge.proxy_url.as_deref(),
        )
    } else {
        proxy_source(
            &mode,
            profile.proxy_session_id.as_deref(),
            profile.proxy_url.as_deref(),
        )
    }
}

pub fn resolve_effective_proxy_url(
    state: &crate::state::AppState,
    bridge: &AcpBridgeConfig,
    profile: &AcpProfileConfig,
) -> Result<Option<String>, String> {
    match effective_proxy_source(bridge, profile)? {
        AcpProxySource::Direct => Ok(None),
        AcpProxySource::App => {
            Ok(crate::proxy::resolve_default(state)?.map(|proxy| proxy.to_url()))
        }
        AcpProxySource::Session(session_id) => Ok(crate::proxy::resolve_session_proxy(
            state,
            &session_id,
        )?
        .map(|proxy| proxy.to_url())),
        AcpProxySource::Manual(url) => Ok(Some(validate_proxy_url(&url)?)),
    }
}

pub fn process_config(
    profile: &AcpProfileConfig,
    cwd: Option<&Path>,
    proxy_url: Option<&str>,
    request_timeout: Duration,
) -> Result<AcpProcessConfig, String> {
    let command = profile.command.trim();
    if command.is_empty() {
        return Err(format!("ACP profile `{}` has no command", profile.id));
    }
    let mut config =
        AcpProcessConfig::new(command, profile.args.clone()).with_request_timeout(request_timeout);
    if let Some(cwd) = cwd {
        config = config.with_current_dir(cwd);
    }
    apply_proxy_environment(config, proxy_url)
}

pub fn apply_proxy_environment(
    mut config: AcpProcessConfig,
    proxy_url: Option<&str>,
) -> Result<AcpProcessConfig, String> {
    for key in PROXY_ENV_KEYS.into_iter().chain(NO_PROXY_ENV_KEYS) {
        config = config.without_env(key);
    }
    if let Some(proxy_url) = proxy_url.map(str::trim).filter(|url| !url.is_empty()) {
        let proxy_url = validate_proxy_url(proxy_url)?;
        for key in PROXY_ENV_KEYS {
            config = config.with_env(key, &proxy_url);
        }
    }
    for key in NO_PROXY_ENV_KEYS {
        config = config.with_env(key, LOOPBACK_NO_PROXY);
    }
    Ok(config)
}

fn default_global_proxy_mode() -> String {
    "direct".into()
}

fn default_profile_proxy_mode() -> String {
    "inherit".into()
}

fn normalize_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_profile_id(value: &str, fallback_index: usize) -> String {
    let mut normalized = String::with_capacity(value.len().min(64));
    let mut last_was_separator = false;
    for ch in value.trim().chars().take(64) {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            normalized.push(ch);
            last_was_separator = false;
        } else if !last_was_separator && !normalized.is_empty() {
            normalized.push('-');
            last_was_separator = true;
        }
    }
    let normalized = normalized.trim_matches(['.', '_', '-']);
    if normalized.is_empty() {
        format!("profile-{fallback_index}")
    } else {
        normalized.to_string()
    }
}

fn proxy_source(
    mode: &str,
    session_id: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<AcpProxySource, String> {
    match mode {
        "app" => Ok(AcpProxySource::App),
        "session" => session_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| AcpProxySource::Session(id.to_string()))
            .ok_or_else(|| "ACP session proxy mode requires a proxy session".into()),
        "manual" => proxy_url
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(validate_proxy_url)
            .transpose()?
            .map(AcpProxySource::Manual)
            .ok_or_else(|| "ACP manual proxy mode requires a proxy URL".into()),
        _ => Ok(AcpProxySource::Direct),
    }
}

fn validate_proxy_url(value: &str) -> Result<String, String> {
    let parsed = url::Url::parse(value).map_err(|_| "ACP proxy URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return Err("ACP proxy URL must use http, https, socks5, or socks5h".into());
    }
    if parsed.host_str().is_none() {
        return Err("ACP proxy URL must include a host".into());
    }
    Ok(value.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_exposes_disabled_grok_without_enabling_acp() {
        let config = AcpBridgeConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.active_profile_id.as_deref(), Some("grok"));
        assert_eq!(config.profiles, [super::super::presets::grok_profile()]);
        assert!(config.active_profile().is_none());
        assert!(config.profile("acp:grok").is_some());
    }

    #[test]
    fn normalization_produces_stable_unique_provider_ids() {
        let mut config = AcpBridgeConfig {
            active_profile_id: Some(" MY Agent ".into()),
            profiles: vec![
                AcpProfileConfig {
                    id: " MY Agent ".into(),
                    name: String::new(),
                    ..Default::default()
                },
                AcpProfileConfig {
                    id: "my/agent".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        config.normalize();
        assert_eq!(config.profiles[0].id, "my-agent");
        assert_eq!(config.profiles[0].name, "my-agent");
        assert_eq!(config.profiles[1].id, "my-agent-2");
        assert_eq!(config.active_profile_id.as_deref(), Some("my-agent"));
        assert_eq!(
            provider_id_for_profile(&config.profiles[1].id),
            "acp:my-agent-2"
        );
    }

    #[test]
    fn enabled_bridge_migrates_preferred_configured_profile_to_enabled() {
        let mut config = AcpBridgeConfig {
            enabled: true,
            ..Default::default()
        };

        assert!(!config.profiles[0].enabled);
        config.normalize();

        assert_eq!(config.active_profile_id.as_deref(), Some("grok"));
        assert!(config.profiles[0].enabled);
        assert_eq!(
            config.active_profile().map(|profile| profile.id.as_str()),
            Some("grok")
        );
    }

    #[test]
    fn disabled_bridge_keeps_default_profiles_disabled() {
        let mut config = AcpBridgeConfig::default();

        config.normalize();

        assert!(!config.enabled);
        assert!(!config.profiles[0].enabled);
        assert!(config.active_profile().is_none());
    }

    #[test]
    fn grok_media_capabilities_keep_legacy_support_but_honor_opt_out() {
        let mut legacy = AcpProfileConfig {
            id: "grok".into(),
            command: "grok".into(),
            args: vec!["agent".into(), "stdio".into()],
            ..Default::default()
        };
        assert!(legacy.supports_image_generation());
        assert!(legacy.supports_video_generation());

        legacy.capabilities = AcpProfileCapabilities {
            image_generation: Some(false),
            video_generation: Some(false),
        };
        assert!(!legacy.supports_image_generation());
        assert!(!legacy.supports_video_generation());

        let generic = AcpProfileConfig {
            id: "another-agent".into(),
            capabilities: AcpProfileCapabilities {
                image_generation: Some(true),
                video_generation: Some(true),
            },
            ..Default::default()
        };
        assert!(!generic.supports_image_generation());
        assert!(!generic.supports_video_generation());
    }

    #[test]
    fn profile_proxy_override_and_global_fallback_are_explicit() {
        let mut bridge = AcpBridgeConfig {
            proxy_mode: "app".into(),
            ..Default::default()
        };
        let mut profile = super::super::presets::grok_profile();
        assert_eq!(
            effective_proxy_source(&bridge, &profile).unwrap(),
            AcpProxySource::App
        );

        profile.proxy_mode = "direct".into();
        assert_eq!(
            effective_proxy_source(&bridge, &profile).unwrap(),
            AcpProxySource::Direct
        );

        profile.proxy_mode = "manual".into();
        profile.proxy_url = Some("socks5://127.0.0.1:1080".into());
        assert_eq!(
            effective_proxy_source(&bridge, &profile).unwrap(),
            AcpProxySource::Manual("socks5://127.0.0.1:1080".into())
        );

        bridge.proxy_mode = "session".into();
        bridge.proxy_session_id = None;
        profile.proxy_mode = "inherit".into();
        assert!(effective_proxy_source(&bridge, &profile).is_err());
    }

    #[test]
    fn process_environment_clears_inherited_proxies_in_direct_mode() {
        let profile = super::super::presets::grok_profile();
        let config = process_config(
            &profile,
            Some(Path::new("/tmp/project")),
            None,
            Duration::from_secs(45),
        )
        .unwrap();
        for key in PROXY_ENV_KEYS {
            assert!(config.env_remove.contains(key));
            assert!(!config.env.contains_key(key));
        }
        assert_eq!(
            config.env.get("NO_PROXY").map(String::as_str),
            Some(LOOPBACK_NO_PROXY)
        );
        assert_eq!(
            config.env.get("no_proxy").map(String::as_str),
            Some(LOOPBACK_NO_PROXY)
        );
        assert_eq!(
            config.current_dir.as_deref(),
            Some(Path::new("/tmp/project"))
        );
        assert_eq!(config.request_timeout, Duration::from_secs(45));
    }

    #[test]
    fn process_environment_sets_proxy_cases_and_rejects_unsafe_schemes() {
        let config = apply_proxy_environment(
            AcpProcessConfig::new("agent", Vec::new()),
            Some("http://user:pass@127.0.0.1:8080"),
        )
        .unwrap();
        for key in PROXY_ENV_KEYS {
            assert_eq!(
                config.env.get(key).map(String::as_str),
                Some("http://user:pass@127.0.0.1:8080")
            );
        }
        assert!(
            apply_proxy_environment(
                AcpProcessConfig::new("agent", Vec::new()),
                Some("file:///tmp/proxy"),
            )
            .is_err()
        );
    }

    #[test]
    fn request_timeout_is_bounded() {
        let mut config = AcpBridgeConfig {
            request_timeout_seconds: u64::MAX,
            ..Default::default()
        };
        config.normalize();
        assert_eq!(config.request_timeout(), Duration::from_secs(600));
    }
}
