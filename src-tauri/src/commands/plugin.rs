use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

pub use super::plugin_network::PluginDownloadProxyEndpoint;
use crate::{
    plugin::{
        PluginRecord,
        download::{
            DownloadProgress, DownloadRequest, ModuleCatalog, ProxyRoute,
            validate_download_paths_within_root,
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
        .unwrap_or_else(|| crate::plugin::migration::LEGACY_SOURCE_VERSION.to_owned())
}

pub(super) fn publish_registry_change(app: &AppHandle, result: &Result<PluginRecord, String>) {
    // Only invalidate renderer projections. Every WebView must re-read the
    // registry, never accept an event payload as installation/activation proof.
    let slug = result
        .as_ref()
        .ok()
        .map(|record| record.manifest.slug.as_str());
    let _ = app.emit(
        "plugin-registry-changed",
        serde_json::json!({ "slug": slug }),
    );
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
    app: AppHandle,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        registry
            .set_enabled(&slug, enabled)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    publish_registry_change(&app, &result);
    result
}

/// Compatibility entry point: unsigned renderer directories are rejected.
#[tauri::command]
pub fn plugin_install_staged(
    slug: String,
    version: String,
    package_dir: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PluginRecord, String> {
    let result = state
        .plugins
        .install_staged(&slug, &version, &PathBuf::from(package_dir))
        .map_err(|error| error.to_string());
    publish_registry_change(&app, &result);
    result
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
    app: AppHandle,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|error| error.to_string())?;
    publish_registry_change(&app, &result);
    result
}

#[tauri::command]
pub async fn plugin_rollback(
    slug: String,
    version: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        registry
            .rollback_to(&slug, version.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    publish_registry_change(&app, &result);
    result
}

#[tauri::command]
pub async fn plugin_uninstall(
    slug: String,
    delete_data: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        registry
            .uninstall(&slug, delete_data.unwrap_or(false))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    publish_registry_change(&app, &result);
    result
}

#[tauri::command]
pub async fn plugin_refresh(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<PluginRecord>, String> {
    let registry = state.plugins.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        registry.scan().map_err(|error| error.to_string())?;
        Ok(registry.list())
    })
    .await
    .map_err(|error| error.to_string())?;
    let _ = app.emit(
        "plugin-registry-changed",
        serde_json::json!({ "slug": null }),
    );
    result
}

#[tauri::command]
pub async fn plugin_invoke(
    slug: String,
    command: String,
    payload: Option<Value>,
    request_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, taomni_plugin_api::RpcError> {
    if (slug == crate::vnc::MODULE_SLUG && command.starts_with("vnc/"))
        || (slug == taomni_server_process::vnc::SLUG
            && taomni_server_process::vnc::COMMANDS.contains(&command.as_str()))
        || (slug == taomni_server_process::rdp::SLUG
            && taomni_server_process::rdp::COMMANDS.contains(&command.as_str()))
        || (slug == taomni_server_process::local::SLUG
            && taomni_server_process::local::COMMANDS.contains(&command.as_str()))
        || (slug == taomni_screenshot_api::SLUG
            && taomni_screenshot_api::COMMANDS.contains(&command.as_str()))
        || (slug == taomni_local_voice_api::SLUG
            && taomni_local_voice_api::COMMANDS.contains(&command.as_str()))
        || (slug == taomni_mail_api::SLUG
            && matches!(
                command.as_str(),
                taomni_mail_api::CHECK_INCOMING
                    | taomni_mail_api::CHECK_OUTGOING
                    | taomni_mail_api::IMAP_FOLDER_TREE
                    | taomni_mail_api::MUTATE_IMAP_FOLDER
                    | taomni_mail_api::SEND_SMTP
                    | taomni_mail_api::STORE_IMAP_SENT
                    | taomni_mail_api::STORE_IMAP_DRAFT
                    | taomni_mail_api::DISCARD_IMAP_DRAFT
                    | taomni_mail_api::SYNC_IMAP_HEADERS
                    | taomni_mail_api::SYNC_IMAP_ROUND
                    | taomni_mail_api::SEARCH_IMAP
                    | taomni_mail_api::SET_IMAP_FLAGS
                    | taomni_mail_api::LIST_IMAP_UNREAD
                    | taomni_mail_api::FETCH_IMAP_RAW
                    | taomni_mail_api::FETCH_IMAP_BODY
                    | taomni_mail_api::PREFETCH_IMAP_BODIES
                    | taomni_mail_api::OPEN_IMAP_ARCHIVE
                    | taomni_mail_api::FETCH_IMAP_ATTACHMENT
            ))
    {
        // The desktop commands resolve these routes and credentials.
        return Err(taomni_plugin_api::RpcError::from_code(
            taomni_plugin_api::ErrorCode::MethodNotFound,
        ));
    }
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
    proxy_mode: Option<String>,
    application_proxy: Option<PluginDownloadProxyEndpoint>,
    feature_proxy: Option<PluginDownloadProxyEndpoint>,
    state: State<'_, AppState>,
) -> Result<DownloadProgress, String> {
    let service =
        super::plugin_network::service(&state, proxy_mode, application_proxy, feature_proxy)?;
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
        proxy: ProxyRoute::NoProxy,
    };
    state
        .plugin_downloads
        .start_with_service(request, service)
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
    state
        .plugin_downloads
        .forget(&id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugin_download_list(
    state: State<'_, AppState>,
) -> Result<crate::plugin::download::DownloadListing, String> {
    Ok(state.plugin_downloads.list().await)
}

#[tauri::command]
pub async fn plugin_download_resume(
    id: String,
    proxy_mode: Option<String>,
    application_proxy: Option<PluginDownloadProxyEndpoint>,
    feature_proxy: Option<PluginDownloadProxyEndpoint>,
    state: State<'_, AppState>,
) -> Result<DownloadProgress, String> {
    let service =
        super::plugin_network::service(&state, proxy_mode, application_proxy, feature_proxy)?;
    state
        .plugin_downloads
        .resume_with_service(&id, service)
        .await
        .map_err(|error| error.to_string())?;
    state
        .plugin_downloads
        .snapshot(&id)
        .await
        .ok_or_else(|| "module download task was not registered".to_owned())
}

/// Fetch and authenticate the catalog and its detached signature over the
/// same selected proxy. Persist the verified bytes for subsequent installs.
#[tauri::command]
pub async fn plugin_catalog_fetch(
    url: String,
    proxy_mode: Option<String>,
    application_proxy: Option<PluginDownloadProxyEndpoint>,
    feature_proxy: Option<PluginDownloadProxyEndpoint>,
    state: State<'_, AppState>,
) -> Result<ModuleCatalog, String> {
    let service =
        super::plugin_network::service(&state, proxy_mode, application_proxy, feature_proxy)?;
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
    use crate::plugin::migration::{MigrationItem, MigrationJournal};
    let root = legacy_profile_root(&state);
    let mut snapshot = inspect_legacy_profile(&root, from_version, &state)?;
    if let Ok(journal) = MigrationJournal::load(&root.join("migration/journal.json")) {
        let retained_vnc = journal.retained_vnc_sessions();
        let migrated_rdp_pins = journal.committed_rdp_pins().unwrap_or(false);
        snapshot
            .candidates
            .retain(|candidate| match candidate.item {
                MigrationItem::VncSessions => !retained_vnc,
                MigrationItem::RdpCertificatePins => !migrated_rdp_pins,
                _ => true,
            });
    }
    Ok(snapshot)
}

fn inspect_legacy_profile(
    root: &std::path::Path,
    from_version: Option<String>,
    state: &AppState,
) -> Result<crate::plugin::migration::LegacyInstallSnapshot, String> {
    use crate::plugin::migration::{MigrationItem, inspect_legacy_install};
    let mut snapshot = inspect_legacy_install(root, legacy_version(from_version))?;
    if state.legacy.mfa.legacy_store()?.is_none() {
        snapshot
            .candidates
            .retain(|candidate| candidate.item != MigrationItem::Mfa);
    }
    Ok(snapshot)
}

/// Acknowledge sessions retained by the core after the signed VNC viewer is ready.
/// Other candidates keep their journal state until their exporters run.
#[tauri::command]
pub fn plugin_migration_execute(
    from_version: Option<String>,
    state: State<'_, AppState>,
) -> Result<crate::plugin::migration::MigrationExecutionResult, String> {
    let source_root = legacy_profile_root(&state);
    let snapshot = inspect_legacy_profile(&source_root, from_version, &state)?;
    let retain_vnc =
        snapshot.candidates.iter().any(|candidate| {
            candidate.item == crate::plugin::migration::MigrationItem::VncSessions
        }) && state.plugins.has_verified_vnc_client();
    let journal_path = source_root.join("migration").join("journal.json");
    let executor = crate::plugin::migration::MigrationExecutor::new(
        source_root,
        state.plugins.root().to_path_buf(),
        journal_path,
        snapshot.from_version.clone(),
        crate::plugin::CORE_API_VERSION,
    )?;
    state
        .plugins
        .record_legacy_migration(&executor, &snapshot, retain_vnc)
}

#[tauri::command]
pub async fn plugin_mfa_migrate_and_restart(
    app: AppHandle,
    archive: Option<PathBuf>,
    signature: Option<PathBuf>,
    master_password: String,
) -> Result<(), String> {
    let request = zeroize::Zeroizing::new(master_password);
    let owner = app.clone();
    let handoff = tauri::async_runtime::spawn_blocking(move || {
        let package = match (archive, signature) {
            (Some(archive), Some(signature)) => (archive, signature),
            (None, None) => {
                use tauri::Manager;
                owner
                    .state::<AppState>()
                    .plugins
                    .installed_mfa_upgrade_package()?
            }
            _ => return Err("Choose both the MFA package and its detached signature".into()),
        };
        crate::runtime::mfa_restart::MfaRestart::prepare(&owner, package.0, package.1, request)
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::runtime::shutdown::request(
        app,
        crate::runtime::shutdown::ExitAction::UpgradeMfa(handoff),
    )
    .await
}

#[tauri::command]
pub fn plugin_mfa_migration_result(state: State<'_, AppState>) -> Option<&'static str> {
    let result = crate::runtime::mfa_restart::last_result()?;
    if result == "complete" && !matches!(state.legacy.mfa.legacy_store(), Ok(None)) {
        return None;
    }
    Some(result)
}

pub(super) fn handles(command: &str) -> bool {
    matches!(
        command,
        "plugin_list"
            | "plugin_set_enabled"
            | "plugin_install_staged"
            | "plugin_install_archive"
            | "plugin_rollback"
            | "plugin_uninstall"
            | "plugin_refresh"
            | "plugin_invoke"
            | "plugin_cancel_request"
            | "plugin_download_start"
            | "plugin_download_status"
            | "plugin_download_cancel"
            | "plugin_download_forget"
            | "plugin_download_list"
            | "plugin_download_resume"
            | "plugin_catalog_fetch"
            | "plugin_network_get"
            | "plugin_network_save"
            | "plugin_marketplace_catalog"
            | "plugin_marketplace_download"
            | "plugin_marketplace_review"
            | "plugin_marketplace_install"
            | "plugin_marketplace_provision"
            | "plugin_marketplace_dismiss_new"
            | "plugin_migration_inspect"
            | "plugin_migration_execute"
            | "plugin_mfa_migrate_and_restart"
            | "plugin_mfa_migration_result"
    )
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
        crate::commands::plugin::plugin_download_list,
        crate::commands::plugin::plugin_download_resume,
        crate::commands::plugin::plugin_catalog_fetch,
        crate::commands::plugin_network::plugin_network_get,
        crate::commands::plugin_network::plugin_network_save,
        crate::commands::plugin_marketplace::plugin_marketplace_catalog,
        crate::commands::plugin_marketplace::plugin_marketplace_download,
        crate::commands::plugin_marketplace::plugin_marketplace_review,
        crate::commands::plugin_marketplace::plugin_marketplace_install,
        crate::commands::plugin_marketplace::plugin_marketplace_provision,
        crate::commands::plugin_marketplace::plugin_marketplace_dismiss_new,
        crate::commands::plugin::plugin_migration_inspect,
        crate::commands::plugin::plugin_migration_execute,
        crate::commands::plugin::plugin_mfa_migrate_and_restart,
        crate::commands::plugin::plugin_mfa_migration_result,
    ];
    handler(invoke)
}
