//! Application-level outbound proxy.
//!
//! A single global proxy the app can route its own network traffic through —
//! distinct from the per-session proxy in `terminal::network`. The config is
//! persisted to `~/.config/taomni/proxy.json` and can either point at a saved
//! `SessionType::Proxy` session (`mode == "session"`) or carry its own manual
//! fields (`mode == "manual"`).
//!
//! [`resolve_default`] is the single reuse entry point: it loads the config,
//! resolves the proxy (looking up the referenced session and decrypting the
//! vault-stored password as needed) and hands back a [`ResolvedProxy`]. Other
//! outbound modules (updater, LLM, search, model downloader, …) build their
//! HTTP client with [`ResolvedProxy::apply_to`] / [`ResolvedProxy::to_url`]
//! rather than re-implementing proxy plumbing.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

use crate::state::AppState;

fn default_mode() -> String {
    "manual".into()
}
fn default_kind() -> String {
    "http".into()
}
fn default_port() -> u16 {
    3128
}

/// Persisted application-proxy configuration (`~/.config/taomni/proxy.json`).
/// Field names are snake_case to match the `ai.json` convention; the frontend
/// `AppProxyConfig` interface mirrors these keys verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppProxyConfig {
    /// Master switch. When false the app makes direct connections.
    #[serde(default)]
    pub enabled: bool,
    /// "session" — use the proxy session referenced by `session_id`.
    /// "manual"  — use the `kind`/`host`/`port`/`username`/`password_ref` below.
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Saved `SessionType::Proxy` session id, used when `mode == "session"`.
    #[serde(default)]
    pub session_id: String,
    /// "http" | "socks5" (manual mode).
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// `vault:<id>` reference to the manual password. Never plaintext: the
    /// frontend stores the secret in the vault and keeps only the ref here.
    #[serde(default)]
    pub password_ref: String,
}

impl Default for AppProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: default_mode(),
            session_id: String::new(),
            kind: default_kind(),
            host: String::new(),
            port: default_port(),
            username: String::new(),
            password_ref: String::new(),
        }
    }
}

impl AppProxyConfig {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(path, json)
    }
}

pub fn default_app_proxy_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("taomni")
        .join("proxy.json")
}

/// A fully-resolved proxy ready to drive an HTTP client: scheme + endpoint +
/// already-decrypted credentials. This is the shape every consuming module
/// works with, so none of them need to know about config files, sessions, or
/// the vault.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedProxy {
    /// "http" | "socks5".
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Plaintext password (already resolved from the vault); empty = no auth.
    pub password: String,
}

impl ResolvedProxy {
    /// Build a proxy URL string (`http://user:pass@host:port` /
    /// `socks5://...`). Credentials are percent-encoded. This format is what
    /// `reqwest::Proxy::all` and `tauri-plugin-updater`'s `proxy` option both
    /// accept.
    pub fn to_url(&self) -> String {
        let scheme = if self.kind == "socks5" {
            "socks5"
        } else {
            "http"
        };
        let auth = if self.username.is_empty() {
            String::new()
        } else {
            format!(
                "{}:{}@",
                urlencoding::encode(&self.username),
                urlencoding::encode(&self.password),
            )
        };
        format!("{}://{}{}:{}", scheme, auth, self.host, self.port)
    }

    /// Generic reuse hook: attach this proxy to a `reqwest::ClientBuilder`.
    /// SOCKS5 requires the reqwest `socks` feature (enabled in Cargo.toml). A
    /// malformed URL leaves the builder unchanged (direct connection).
    pub fn apply_to(&self, builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        match reqwest::Proxy::all(self.to_url()) {
            Ok(proxy) => builder.proxy(proxy),
            Err(_) => builder,
        }
    }
}

/// Resolve a password reference into plaintext. An empty value means "no
/// password". A `vault:<id>` ref is decrypted; if the vault is locked or the
/// entry is missing we degrade to an empty password (and log) rather than
/// failing the whole resolution — a startup updater check must not hard-fail
/// just because the vault hasn't been unlocked yet.
fn resolve_password(state: &AppState, password_ref: &str) -> String {
    if password_ref.is_empty() {
        return String::new();
    }
    match state.vault.resolve(password_ref) {
        Ok(Some(plain)) => (*plain).clone(),
        // Not a vault ref (shouldn't happen — we only store refs — but treat
        // the raw value as the password for robustness).
        Ok(None) => password_ref.to_string(),
        Err(e) => {
            tracing::warn!("app proxy: could not resolve password ref: {e}");
            String::new()
        }
    }
}

/// Load the persisted config and resolve it into a concrete [`ResolvedProxy`],
/// or `None` when the proxy is disabled / unconfigured. This is the one entry
/// point other modules call.
pub fn resolve_default(state: &AppState) -> Result<Option<ResolvedProxy>, String> {
    let config = AppProxyConfig::load(&default_app_proxy_path());
    resolve(state, &config)
}

/// Resolve an explicit config (used by [`resolve_default`] and tests).
pub fn resolve(state: &AppState, config: &AppProxyConfig) -> Result<Option<ResolvedProxy>, String> {
    if !config.enabled {
        return Ok(None);
    }

    if config.mode == "session" {
        let id = config.session_id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        return resolve_session_proxy(state, id);
    }

    // Manual mode.
    if config.host.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(ResolvedProxy {
        kind: if config.kind == "socks5" {
            "socks5".into()
        } else {
            "http".into()
        },
        host: config.host.trim().to_string(),
        port: config.port,
        username: config.username.trim().to_string(),
        password: resolve_password(state, &config.password_ref),
    }))
}

/// Resolve a saved `SessionType::Proxy` session into a concrete proxy. This is
/// reused by features such as Codex bridge profiles that need the same proxy
/// session semantics as the global Application Proxy setting.
pub fn resolve_session_proxy(
    state: &AppState,
    session_id: &str,
) -> Result<Option<ResolvedProxy>, String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    let session = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::session::db::get_session(&db, id)
            .map_err(|e| format!("proxy session not found: {e}"))?
    };
    let opts: serde_json::Value =
        serde_json::from_str(&session.options_json).unwrap_or(serde_json::Value::Null);
    let kind = opts
        .get("proxyKind")
        .and_then(|k| k.as_str())
        .unwrap_or("http")
        .to_string();
    let password_ref = opts
        .get("passwordRef")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Some(ResolvedProxy {
        kind,
        host: session.host,
        port: session.port,
        username: session.username.unwrap_or_default(),
        password: resolve_password(state, &password_ref),
    }))
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_app_proxy_config(_state: State<'_, AppState>) -> Result<AppProxyConfig, String> {
    Ok(AppProxyConfig::load(&default_app_proxy_path()))
}

#[tauri::command]
pub async fn save_app_proxy_config(
    config: AppProxyConfig,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    config
        .save(&default_app_proxy_path())
        .map_err(|e| e.to_string())
}

/// Resolved proxy URL for the frontend updater (and any JS-side consumer).
/// Returns `None` for a direct connection. Any resolution error degrades to
/// `None` so a misconfigured/locked proxy never blocks update checks.
#[tauri::command]
pub async fn get_app_proxy_url(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(resolve_default(&state).ok().flatten().map(|p| p.to_url()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_through_json() {
        let cfg = AppProxyConfig {
            enabled: true,
            mode: "manual".into(),
            session_id: String::new(),
            kind: "socks5".into(),
            host: "10.0.0.1".into(),
            port: 1080,
            username: "alice".into(),
            password_ref: "vault:abc".into(),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: AppProxyConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, "socks5");
        assert_eq!(back.port, 1080);
        assert_eq!(back.password_ref, "vault:abc");
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // Forward-compat: an older/partial file must still deserialize.
        let cfg: AppProxyConfig = serde_json::from_str("{}").unwrap();
        assert!(!cfg.enabled);
        assert_eq!(cfg.mode, "manual");
        assert_eq!(cfg.kind, "http");
        assert_eq!(cfg.port, 3128);
    }

    #[test]
    fn to_url_http_with_auth_is_percent_encoded() {
        let p = ResolvedProxy {
            kind: "http".into(),
            host: "proxy.example.com".into(),
            port: 3128,
            username: "user name".into(),
            password: "p@ss/word".into(),
        };
        assert_eq!(
            p.to_url(),
            "http://user%20name:p%40ss%2Fword@proxy.example.com:3128"
        );
    }

    #[test]
    fn to_url_socks5_without_auth() {
        let p = ResolvedProxy {
            kind: "socks5".into(),
            host: "127.0.0.1".into(),
            port: 1080,
            username: String::new(),
            password: String::new(),
        };
        assert_eq!(p.to_url(), "socks5://127.0.0.1:1080");
    }

    #[test]
    fn unknown_kind_falls_back_to_http_scheme() {
        let p = ResolvedProxy {
            kind: "weird".into(),
            host: "h".into(),
            port: 8080,
            username: String::new(),
            password: String::new(),
        };
        assert_eq!(p.to_url(), "http://h:8080");
    }
}
