//! Official signed catalog → deterministic resumable transfer → verified install.
use tauri::{AppHandle, State};

use crate::{
    plugin::{
        InstallIntent, PluginRecord,
        download::{DownloadError, DownloadInfo, DownloadPhase, DownloadRequest},
        marketplace::{self, CatalogSelection, InstallReview, MarketplaceCatalog},
        migration_mail_provision, release_state,
    },
    state::AppState,
};

#[tauri::command]
pub async fn plugin_marketplace_catalog(
    url: Option<String>,
    state: State<'_, AppState>,
) -> Result<MarketplaceCatalog, String> {
    // A signed mirror is a transport choice, never a new trust anchor. The
    // native verifier and durable sequence apply equally to every source.
    let url = url.unwrap_or_else(|| marketplace::OFFICIAL_CATALOG_URL.into());
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid module catalog URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Use an HTTP(S) catalog URL without credentials or a fragment".into());
    }
    let service = super::plugin_network::service(&state, None, None, None)?;
    let catalog =
        crate::plugin::fetch_trusted_catalog(&service, &url, state.plugins.root()).await?;
    let data = state.core.paths.data.clone();
    let platform = crate::plugin::current_platform();
    tauri::async_runtime::spawn_blocking(move || {
        let release = release_state::plan(&data, &catalog, platform)?;
        Ok(MarketplaceCatalog {
            catalog,
            platform: platform.into(),
            release,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_marketplace_dismiss_new(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let data = state.core.paths.data.clone();
    tauri::async_runtime::spawn_blocking(move || release_state::dismiss(&data, &ids))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_marketplace_download(
    selection: CatalogSelection,
    installed_version: Option<String>,
    state: State<'_, AppState>,
) -> Result<DownloadInfo, String> {
    let plan = resolve_download(&state, selection, installed_version).await?;
    start_download(&state, plan, true).await
}

async fn resolve_download(
    state: &AppState,
    selection: CatalogSelection,
    installed_version: Option<String>,
) -> Result<DownloadRequest, String> {
    let root = state.plugins.root().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        marketplace::download_plan(&root, &selection, installed_version.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

async fn start_download(
    state: &AppState,
    plan: DownloadRequest,
    retry: bool,
) -> Result<DownloadInfo, String> {
    let id = plan.id.clone();
    let completed_path = plan.completed_path.clone();
    let existing = state.plugin_downloads.snapshot(&id).await;
    if existing.is_none()
        || retry
            && existing.is_some_and(|progress| {
                matches!(
                    progress.phase,
                    DownloadPhase::Cancelled | DownloadPhase::Failed
                )
            })
    {
        let service = super::plugin_network::service(&state, None, None, None)?;
        match state
            .plugin_downloads
            .start_with_service(plan, service)
            .await
        {
            Ok(_) | Err(DownloadError::AlreadyActive(_)) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let progress = state
        .plugin_downloads
        .snapshot(&id)
        .await
        .ok_or("Module download disappeared after starting")?;
    Ok(DownloadInfo {
        id,
        completed_path,
        progress,
    })
}

#[tauri::command]
pub async fn plugin_marketplace_review(
    selection: CatalogSelection,
    state: State<'_, AppState>,
) -> Result<InstallReview, String> {
    let root = state.plugins.root().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        marketplace::prepare_install(&root, &selection).map(|(_, review)| review)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugin_marketplace_install(
    selection: CatalogSelection,
    installed_version: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    // Repeat the full verification after confirmation. The renderer review
    // and any file changed while its dialog was open confer no authorization.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (package, _) = marketplace::prepare_install(registry.root(), &selection)
            .map_err(|error| error.to_string())?;
        let intent = installed_version
            .as_deref()
            .map_or(InstallIntent::Explicit, InstallIntent::Update);
        registry
            .install_with_intent(&package, intent)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Install skipped".into())
    })
    .await
    .map_err(|error| error.to_string())?;
    super::plugin::publish_registry_change(&app, &result);
    result
}

#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum ProvisionOutcome {
    Record(Option<PluginRecord>),
    Staged {
        #[serde(rename = "restartRequired")]
        restart_required: bool,
    },
}

#[tauri::command]
pub async fn plugin_marketplace_provision(
    selection: CatalogSelection,
    retry: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ProvisionOutcome, String> {
    let data = state.core.paths.data.clone();
    let id = selection.plugin_id.clone();
    let pending =
        tauri::async_runtime::spawn_blocking(move || release_state::is_pending(&data, &id))
            .await
            .map_err(|error| error.to_string())??;
    if !pending {
        return Ok(ProvisionOutcome::Record(None));
    }
    let plan = resolve_download(&state, selection.clone(), None).await?;
    let task = start_download(&state, plan, retry).await?;
    let progress = state
        .plugin_downloads
        .wait_for_finished(&task.id)
        .await
        .ok_or("Module download was removed; retry the installation")?;
    if progress.phase != DownloadPhase::Completed {
        return Err(progress
            .error
            .unwrap_or_else(|| "Module download cancelled; retry to resume".into()));
    }
    let registry = state.plugins.clone();
    let core = state.core.clone();
    let data = state.core.paths.data.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let (package, _) = marketplace::prepare_install(registry.root(), &selection)
            .map_err(|error| error.to_string())?;
        if selection.plugin_id == migration_mail_provision::MAIL_ID {
            let has_legacy_accounts = {
                let db = core.db.lock().map_err(|error| error.to_string())?;
                migration_mail_provision::has_legacy_accounts(&db)?
            };
            if has_legacy_accounts && migration_mail_provision::queue(&data, &package)? {
                return Ok::<_, String>(ProvisionOutcome::Staged {
                    restart_required: true,
                });
            }
        }
        let record = registry
            .install_with_intent(&package, InstallIntent::Legacy)
            .map_err(|error| error.to_string())?;
        release_state::complete(&data, &selection.plugin_id)?;
        Ok(ProvisionOutcome::Record(record))
    })
    .await
    .map_err(|error| error.to_string())??;
    if let ProvisionOutcome::Record(Some(record)) = &outcome {
        super::plugin::publish_registry_change(&app, &Ok(record.clone()));
    }
    Ok(outcome)
}
