use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

use crate::{
    plugin::{
        PluginRecord,
        download::{
            DownloadProgress, DownloadRequest, ModuleCatalog, ProxyEndpoint, ProxyRoute,
            parse_proxy_mode, resolve_proxy_route, validate_download_paths_within_root,
        },
    },
    state::AppState,
};

fn legacy_profile_root(state: &AppState) -> PathBuf {
    state.core.paths.data.clone()
}

fn legacy_version(value: Option<String>) -> String {
    value
        .filter(|version| !version.trim().is_empty())
        .unwrap_or_else(|| "0.5.x".to_owned())
}

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
pub async fn plugin_set_enabled(
    slug: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry
            .set_enabled(&slug, enabled)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Compatibility entry point: unsigned renderer directories are rejected.
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

/// Install a signed offline archive, or an artifact bound to the last verified
/// remote catalog. Neither caller-provided platform nor a verification flag is
/// accepted as proof of trust.
#[tauri::command]
pub async fn plugin_install_archive(
    archive_path: String,
    detached_signature: Option<String>,
    plugin_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(archive_path);
        let package = match (plugin_id, detached_signature) {
            (Some(id), None) => {
                crate::plugin::package_from_cached_catalog(&path, registry.root(), &id)
                    .map_err(|error| error.to_string())?
            }
            (None, Some(signature)) => crate::plugin::verify::VerifiedPackage::from_offline(
                &path,
                &signature,
                crate::plugin::current_platform(),
            )
            .map_err(|error| error.to_string())?,
            _ => {
                return Err(
                    "provide either a catalog plugin id or an offline detached signature".into(),
                );
            }
        };
        registry
            .install_verified(&package)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_rollback(
    slug: String,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry.rollback(&slug).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_uninstall(
    slug: String,
    delete_data: Option<bool>,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry
            .uninstall(&slug, delete_data.unwrap_or(false))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_refresh(state: State<'_, AppState>) -> Result<Vec<PluginRecord>, String> {
    let registry = state.plugins.clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry.scan().map_err(|error| error.to_string())?;
        Ok(registry.list())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_invoke(
    slug: String,
    command: String,
    payload: Option<Value>,
    request_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, taomni_plugin_api::RpcError> {
    let registry = state.plugins.clone();
    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    tauri::async_runtime::spawn_blocking(move || {
        registry
            .invoke_with_id(&slug, &command, payload.unwrap_or(Value::Null), &request_id)
            .map_err(|error| match error {
                crate::plugin::PluginError::Rpc { code, message } => taomni_plugin_api::RpcError {
                    code,
                    message,
                    data: None,
                },
                error => taomni_plugin_api::RpcError::new(
                    match error {
                        crate::plugin::PluginError::CommandDenied { .. } => {
                            taomni_plugin_api::ErrorCode::MethodNotFound
                        }
                        crate::plugin::PluginError::PermissionDenied { .. } => {
                            taomni_plugin_api::ErrorCode::PermissionDenied
                        }
                        crate::plugin::PluginError::NotFound(_)
                        | crate::plugin::PluginError::Disabled(_) => {
                            taomni_plugin_api::ErrorCode::InvalidState
                        }
                        _ => taomni_plugin_api::ErrorCode::InternalError,
                    },
                    error.to_string(),
                ),
            })
    })
    .await
    .map_err(|error| {
        taomni_plugin_api::RpcError::new(
            taomni_plugin_api::ErrorCode::InternalError,
            error.to_string(),
        )
    })?
}

#[tauri::command]
pub fn plugin_cancel_request(slug: String, request_id: String, state: State<'_, AppState>) -> bool {
    state.plugins.cancel_request(&slug, &request_id)
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
    expected_sha256: Option<String>,
    proxy_mode: String,
    application_proxy: Option<PluginDownloadProxyEndpoint>,
    feature_proxy: Option<PluginDownloadProxyEndpoint>,
    state: State<'_, AppState>,
) -> Result<DownloadProgress, String> {
    let route = resolve_download_route(proxy_mode, application_proxy, feature_proxy)?;
    let download_root = state.plugins.root().join(".downloads");
    std::fs::create_dir_all(&download_root)
        .map_err(|error| format!("create module download staging root: {error}"))?;
    let partial_path = PathBuf::from(partial_path);
    let completed_path = PathBuf::from(completed_path);
    validate_download_paths_within_root(&partial_path, &completed_path, &download_root)
        .map_err(|error| error.to_string())?;
    let request = DownloadRequest {
        id: id.clone(),
        url,
        partial_path,
        completed_path,
        expected_total,
        expected_sha256,
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

/// Fetch and authenticate the catalog and its detached signature over the
/// same selected proxy. Persist the verified bytes for subsequent installs.
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
    crate::plugin::fetch_trusted_catalog(&service, &url, state.plugins.root()).await
}

/// Read the installed 0.5.x profile before any upgrade writes occur. The
/// command deliberately derives the profile root from the native registry so
/// a renderer cannot make the migration scanner read an arbitrary directory.
#[tauri::command]
pub fn plugin_migration_inspect(
    from_version: Option<String>,
    state: State<'_, AppState>,
) -> Result<crate::plugin::migration::LegacyInstallSnapshot, String> {
    crate::plugin::migration::inspect_legacy_install(
        &legacy_profile_root(&state),
        legacy_version(from_version),
    )
}

/// Record the upgrade preflight while the signed package installer and the
/// core-owned legacy-table exporter are still being rolled out. Database and
/// file candidates remain pending; this command deliberately does not copy
/// source data, create a pseudo plugin version, or change an active pointer.
#[tauri::command]
pub fn plugin_migration_execute(
    from_version: Option<String>,
    state: State<'_, AppState>,
) -> Result<crate::plugin::migration::MigrationExecutionResult, String> {
    let source_root = legacy_profile_root(&state);
    let snapshot = crate::plugin::migration::inspect_legacy_install(
        &source_root,
        legacy_version(from_version),
    )?;
    let journal_path = source_root.join("migration").join("journal.json");
    let executor = crate::plugin::migration::MigrationExecutor::new(
        source_root,
        state.plugins.root().to_path_buf(),
        journal_path,
        snapshot.from_version.clone(),
        crate::plugin::CORE_API_VERSION,
    )?;
    executor.record_pending(&snapshot)
}

pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::commands::plugin::plugin_list,
        crate::commands::plugin::plugin_set_enabled,
        crate::commands::plugin::plugin_install_staged,
        crate::commands::plugin::plugin_install_archive,
        crate::commands::plugin::plugin_rollback,
        crate::commands::plugin::plugin_uninstall,
        crate::commands::plugin::plugin_refresh,
        crate::commands::plugin::plugin_invoke,
        crate::commands::plugin::plugin_cancel_request,
        crate::commands::plugin::plugin_download_start,
        crate::commands::plugin::plugin_download_status,
        crate::commands::plugin::plugin_download_cancel,
        crate::commands::plugin::plugin_download_forget,
        crate::commands::plugin::plugin_catalog_fetch,
        crate::commands::plugin::plugin_migration_inspect,
        crate::commands::plugin::plugin_migration_execute,
    ];
    handler(invoke)
}
