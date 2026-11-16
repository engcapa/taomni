//! Native Settings and authenticated-client adapter for module networking.
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    plugin::{
        download::{HttpDownloadService, ProxyMode, parse_proxy_mode},
        network::ModuleNetworkConfig,
    },
    proxy::AppProxyConfig,
    state::AppState,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDownloadProxyEndpoint {
    pub kind: String,
    pub host: String,
    pub port: u16,
}

fn path(state: &AppState) -> std::path::PathBuf {
    state.core.paths.config.join("taomni/modules-network.json")
}

#[tauri::command]
pub fn plugin_network_get(state: State<'_, AppState>) -> Result<ModuleNetworkConfig, String> {
    ModuleNetworkConfig::load(&path(&state))
}

#[tauri::command]
pub fn plugin_network_save(
    config: ModuleNetworkConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    config.save(&path(&state))
}

pub(super) fn service(
    state: &AppState,
    proxy_mode: Option<String>,
    application_proxy: Option<PluginDownloadProxyEndpoint>,
    feature_proxy: Option<PluginDownloadProxyEndpoint>,
) -> Result<HttpDownloadService, String> {
    // Retain the old wire field for callers, but application mode always reads
    // native Settings, including session references and Vault credentials.
    let _ = application_proxy;
    let selected = proxy_mode
        .as_deref()
        .map(parse_proxy_mode)
        .transpose()
        .map_err(|error| error.to_string())?;
    let mut settings = match selected {
        Some(ProxyMode::NoProxy | ProxyMode::Application) => ModuleNetworkConfig::default(),
        Some(ProxyMode::Feature) if feature_proxy.is_some() => ModuleNetworkConfig::default(),
        _ => ModuleNetworkConfig::load(&path(state))?,
    };
    if let Some(mode) = proxy_mode {
        settings.mode = mode;
    }
    if let Some(endpoint) = feature_proxy.filter(|_| selected == Some(ProxyMode::Feature)) {
        settings.custom = AppProxyConfig {
            enabled: true,
            kind: endpoint.kind,
            host: endpoint.host,
            port: endpoint.port,
            ..Default::default()
        };
    }
    if parse_proxy_mode(&settings.mode).map_err(|error| error.to_string())? == ProxyMode::NoProxy {
        return HttpDownloadService::with_explicit_proxy(None).map_err(|error| error.to_string());
    }
    let db = state
        .core
        .db
        .lock()
        .map_err(|_| "Module proxy session database is unavailable")?;
    crate::plugin::network::service(
        &settings,
        &state.core.paths.config.join("taomni/proxy.json"),
        Some(&db),
        Some(&state.core.vault),
    )
}
