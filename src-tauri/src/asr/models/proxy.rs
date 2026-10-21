use crate::proxy::AppProxyConfig;
use crate::proxy::ResolvedProxy;
use crate::state::AppState;
use futures::StreamExt;
use serde::Deserialize;
use serde::Serialize;

/// A download takes one snapshot; changing settings affects the next download.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DownloadProxyConfig {
    pub mode: String,
    pub custom: AppProxyConfig,
}
impl Default for DownloadProxyConfig {
    fn default() -> Self {
        Self {
            mode: "app".into(),
            custom: AppProxyConfig::default(),
        }
    }
}
pub(super) fn selected_proxy_config(
    settings: &DownloadProxyConfig,
    app: AppProxyConfig,
) -> Result<Option<AppProxyConfig>, String> {
    let config = match settings.mode.as_str() {
        "none" => return Ok(None),
        "app" => app,
        "custom" => AppProxyConfig {
            enabled: true,
            ..settings.custom.clone()
        },
        _ => return Err("Unknown model download proxy mode".into()),
    };
    if !config.enabled {
        return Ok(None);
    }
    match config.mode.as_str() {
        "session" if !config.session_id.trim().is_empty() => {}
        "manual"
            if !config.host.trim().is_empty()
                && config.port > 0
                && ["http", "socks5"].contains(&config.kind.as_str()) => {}
        _ => return Err("Configure the model download proxy before downloading".into()),
    }
    Ok(Some(config))
}
pub(super) fn download_client(proxy: Option<&ResolvedProxy>) -> Result<reqwest::Client, String> {
    // Always disable OS/environment auto-proxy. Only the selected route applies.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(1800));
    if let Some(proxy) = proxy {
        let url = proxy.to_url();
        // Resolve destination names at the SOCKS proxy, including HF redirects.
        let url = if proxy.kind == "socks5" {
            url.replacen("socks5://", "socks5h://", 1)
        } else {
            url
        };
        builder =
            builder.proxy(reqwest::Proxy::all(&url).map_err(|_| "Invalid model download proxy")?);
    }
    builder
        .build()
        .map_err(|_| "Cannot create model download client".into())
}
pub(super) fn resolve_download_proxy(
    state: &AppState,
    settings: &DownloadProxyConfig,
) -> Result<Option<ResolvedProxy>, String> {
    let app = if settings.mode == "app" {
        AppProxyConfig::load(&crate::proxy::default_app_proxy_path())
    } else {
        AppProxyConfig::default()
    };
    let Some(config) = selected_proxy_config(settings, app)? else {
        return Ok(None);
    };
    crate::proxy::resolve(state, &config)?
        .map(Some)
        .ok_or_else(|| "Selected model download proxy is unavailable".into())
}
