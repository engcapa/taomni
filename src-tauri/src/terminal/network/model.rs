use super::endpoint::parse_endpoint;
use serde::Deserialize;
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkForward {
    pub local: String,
    pub remote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettings {
    #[serde(default = "default_proxy_kind")]
    pub proxy_kind: String,
    #[serde(default)]
    pub custom_proxy: Option<crate::proxy::AppProxyConfig>,
    #[serde(default)]
    pub compression: bool,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_user: String,
    #[serde(default)]
    pub proxy_pass: String,
    /// When set and proxy_kind is "http" or "socks5", the proxy config is
    /// resolved from a saved Proxy session at connect time. Empty means use
    /// the manual fields above.
    #[serde(default)]
    pub proxy_session_id: String,
    #[serde(default = "default_true")]
    pub keep_alive: bool,
    #[serde(default)]
    pub keep_alive_interval_secs: u64,
    #[serde(default = "default_true")]
    pub tcp_nodelay: bool,
    #[serde(default = "default_ip_version")]
    pub ip_version: String,
    #[serde(default)]
    pub local_forwards: Vec<NetworkForward>,

    // --- SSH jump host (proxy_kind == "ssh-tunnel") ---
    /// When set, the jump host is taken from a saved SSH session; the backend
    /// resolves host/port/user/auth from the sessions DB. When empty, the
    /// manual `jump_*` fields below are used instead.
    #[serde(default)]
    pub jump_session_id: String,
    #[serde(default)]
    pub jump_host: String,
    #[serde(default)]
    pub jump_port: u16,
    #[serde(default)]
    pub jump_user: String,
    /// "Password" | "PrivateKey".
    #[serde(default = "default_jump_auth_kind")]
    pub jump_auth_kind: String,
    /// Password, or a `vault:<id>` reference. Used when `jump_auth_kind` is
    /// "Password". Resolved to plaintext by `resolve_jump_secret`.
    #[serde(default)]
    pub jump_password: String,
    /// Private key file path. Used when `jump_auth_kind` is "PrivateKey".
    #[serde(default)]
    pub jump_key_path: String,
}

pub(super) fn default_jump_auth_kind() -> String {
    "Password".into()
}

pub(super) fn default_proxy_kind() -> String {
    "none".into()
}
pub(super) fn default_ip_version() -> String {
    "auto".into()
}
pub(super) fn default_true() -> bool {
    true
}

impl NetworkSettings {
    /// Parse a JSON blob coming from the frontend. Returns `None` for
    /// missing/empty input or unparseable JSON; the caller should treat
    /// that as "use defaults / no proxy".
    pub fn from_json(raw: Option<&str>) -> Option<Self> {
        let s = raw?.trim();
        if s.is_empty() {
            return None;
        }
        match serde_json::from_str::<Self>(s) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!("invalid networkSettings JSON: {}", e);
                None
            }
        }
    }

    pub fn keepalive_duration(&self) -> Option<Duration> {
        if self.keep_alive && self.keep_alive_interval_secs > 0 {
            Some(Duration::from_secs(self.keep_alive_interval_secs))
        } else {
            None
        }
    }

    /// If `proxy_pass` is a `vault:<id>` reference, replace it in-place with
    /// the resolved plaintext. Non-references are left as-is. Returns the
    /// vault error string when locked / missing so the caller can bubble
    /// `VAULT_LOCKED` to the UI.
    pub fn resolve_proxy_pass(&mut self, vault: &crate::vault::Vault) -> Result<(), String> {
        if let Some(plain) = vault.resolve(&self.proxy_pass)? {
            self.proxy_pass = (*plain).clone();
        }
        Ok(())
    }

    /// If `jump_password` is a `vault:<id>` reference, replace it in-place with
    /// the resolved plaintext. Mirrors `resolve_proxy_pass` for the SSH jump
    /// host credential; surfaces `VAULT_LOCKED` when the vault is locked.
    pub fn resolve_jump_secret(&mut self, vault: &crate::vault::Vault) -> Result<(), String> {
        if let Some(plain) = vault.resolve(&self.jump_password)? {
            self.jump_password = (*plain).clone();
        }
        Ok(())
    }

    /// True when this session should be tunnelled through an SSH jump host.
    pub fn uses_jump_host(&self) -> bool {
        self.proxy_kind == "ssh-tunnel"
    }
}
