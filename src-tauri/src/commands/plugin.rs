use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

use crate::{
    plugin::{
        PluginRecord,
        download::{
            DownloadProgress, DownloadRequest, ModuleCatalog, ProxyEndpoint, ProxyRoute,
            parse_proxy_mode, resolve_proxy_route,
        },
    },
    state::AppState,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDownloadProxyEndpoint {
    pub kind: String,
    pub host: String,
    pub port: u16,
}

fn resolve_download_route(
    proxy_mode: String,
    application_proxy: Option<PluginDownloadProxyEndpoint>,
    feature_proxy: Option<PluginDownloadProxyEndpoint>,
) -> Result<ProxyRoute, String> {
    let mode = parse_proxy_mode(&proxy_mode).map_err(|error| error.to_string())?;
    let parse_endpoint =
        |endpoint: Option<PluginDownloadProxyEndpoint>| -> Result<Option<ProxyEndpoint>, String> {
            endpoint
                .map(|value| {
                    let kind = crate::plugin::download::parse_proxy_kind(&value.kind)
                        .map_err(|error| error.to_string())?;
                    Ok(ProxyEndpoint {
                        kind,
                        host: value.host,
                        port: value.port,
                    })
                })
                .transpose()
        };
    resolve_proxy_route(
        mode,
        parse_endpoint(application_proxy)?,
        parse_endpoint(feature_proxy)?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_list(state: State<'_, AppState>) -> Result<Vec<PluginRecord>, String> {
    Ok(state.plugins.list())
}

#[tauri::command]
pub fn plugin_set_enabled(
    slug: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    state
        .plugins
        .set_enabled(&slug, enabled)
        .map_err(|error| error.to_string())
}

/// Install a package directory after the download/verification layer has
/// completed. The native installer stages an immutable version and atomically
/// activates it before refreshing the registry projection.
#[tauri::command]
pub fn plugin_install_staged(
    slug: String,
    version: String,
    package_dir: String,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    state
        .plugins
        .install_staged(&slug, &version, &PathBuf::from(package_dir))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_rollback(slug: String, state: State<'_, AppState>) -> Result<PluginRecord, String> {
    state
        .plugins
        .rollback(&slug)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_uninstall(
    slug: String,
    delete_data: Option<bool>,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    state
        .plugins
        .uninstall(&slug, delete_data.unwrap_or(false))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_refresh(state: State<'_, AppState>) -> Result<Vec<PluginRecord>, String> {
    state.plugins.scan().map_err(|error| error.to_string())?;
    Ok(state.plugins.list())
}

#[tauri::command]
pub fn plugin_invoke(
    slug: String,
    command: String,
    payload: Option<Value>,
    request_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    // request_id is accepted at the IPC boundary for cancellation/retry
    // correlation while the host supervisor is rolled out.
    let _request_id = request_id;
    state
        .plugins
        .invoke(&slug, &command, payload.unwrap_or(Value::Null))
        .map_err(|error| error.to_string())
}

/// Start a resumable module package download. The task remains owned by the
/// native manager after this command returns, so closing the settings view does
/// not cancel it. Paths are validated by the download service and should point
/// at the app's plugin staging directory.
#[tauri::command]
pub async fn plugin_download_start(
    id: String,
    url: String,
    partial_path: String,
    completed_path: String,
    expected_total: Option<u64>,
    proxy_mode: String,
    application_proxy: Option<PluginDownloadProxyEndpoint>,
    feature_proxy: Option<PluginDownloadProxyEndpoint>,
    state: State<'_, AppState>,
) -> Result<DownloadProgress, String> {
    let route = resolve_download_route(proxy_mode, application_proxy, feature_proxy)?;
    let request = DownloadRequest {
        id: id.clone(),
        url,
        partial_path: PathBuf::from(partial_path),
        completed_path: PathBuf::from(completed_path),
        expected_total,
        proxy: route.clone(),
    };
    state
        .plugin_downloads
        .start_with_route(request, route)
        .await
        .map_err(|error| error.to_string())?;
    state
        .plugin_downloads
        .snapshot(&id)
        .await
        .ok_or_else(|| "download task disappeared after start".into())
}

#[tauri::command]
pub async fn plugin_download_status(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<DownloadProgress>, String> {
    Ok(state.plugin_downloads.snapshot(&id).await)
}

#[tauri::command]
pub async fn plugin_download_cancel(
    id: String,
    state: State<'_, AppState>,
) -> Result<DownloadProgress, String> {
    state
        .plugin_downloads
        .cancel(&id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugin_download_forget(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.plugin_downloads.forget(&id).await;
    Ok(())
}

/// Fetch the signed-catalog payload over the selected proxy route. Detached
/// signature verification remains an installation gate; this command never
/// installs artifacts and only returns structurally validated metadata.
#[tauri::command]
pub async fn plugin_catalog_fetch(
    url: String,
    proxy_mode: String,
    application_proxy: Option<PluginDownloadProxyEndpoint>,
    feature_proxy: Option<PluginDownloadProxyEndpoint>,
    state: State<'_, AppState>,
) -> Result<ModuleCatalog, String> {
    let route = resolve_download_route(proxy_mode, application_proxy, feature_proxy)?;
    let service = crate::plugin::download::HttpDownloadService::new(&route)
        .map_err(|error| error.to_string())?;
    service
        .fetch_catalog(&url, crate::plugin::CORE_API_VERSION)
        .await
        .map_err(|error| error.to_string())
}

pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::commands::plugin::plugin_list,
        crate::commands::plugin::plugin_set_enabled,
        crate::commands::plugin::plugin_install_staged,
        crate::commands::plugin::plugin_rollback,
        crate::commands::plugin::plugin_uninstall,
        crate::commands::plugin::plugin_refresh,
        crate::commands::plugin::plugin_invoke,
        crate::commands::plugin::plugin_download_start,
        crate::commands::plugin::plugin_download_status,
        crate::commands::plugin::plugin_download_cancel,
        crate::commands::plugin::plugin_download_forget,
        crate::commands::plugin::plugin_catalog_fetch,
    ];
    handler(invoke)
}
