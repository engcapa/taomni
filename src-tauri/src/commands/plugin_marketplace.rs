//! Official signed catalog → deterministic resumable transfer → verified install.
use tauri::{AppHandle, State};

use crate::{
    plugin::{
        PluginRecord,
        download::{DownloadInfo, DownloadPhase},
        marketplace::{self, CatalogSelection, InstallReview, MarketplaceCatalog},
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
    Ok(MarketplaceCatalog {
        catalog,
        platform: crate::plugin::current_platform().into(),
    })
}

#[tauri::command]
pub async fn plugin_marketplace_download(
    selection: CatalogSelection,
    state: State<'_, AppState>,
) -> Result<DownloadInfo, String> {
    let root = state.plugins.root().to_owned();
    let plan =
        tauri::async_runtime::spawn_blocking(move || marketplace::download_plan(&root, &selection))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
    let id = plan.id.clone();
    let completed_path = plan.completed_path.clone();
    let existing = state.plugin_downloads.snapshot(&id).await;
    if existing.as_ref().is_none_or(|progress| {
        matches!(
            progress.phase,
            DownloadPhase::Cancelled | DownloadPhase::Failed
        )
    }) {
        let service = super::plugin_network::service(&state, None, None, None)?;
        state
            .plugin_downloads
            .start_with_service(plan, service)
            .await
            .map_err(|error| error.to_string())?;
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
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PluginRecord, String> {
    let registry = state.plugins.clone();
    // Repeat the full verification after confirmation. The renderer review
    // and any file changed while its dialog was open confer no authorization.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (package, _) = marketplace::prepare_install(registry.root(), &selection)
            .map_err(|error| error.to_string())?;
        registry
            .install_verified(&package)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    super::plugin::publish_registry_change(&app, &result);
    result
}
