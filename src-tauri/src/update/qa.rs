//! Isolated macOS updater transport for hosted QA. The production plugin still
//! downloads, verifies and installs; only its endpoint and disposable app path differ.

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_updater::UpdaterExt;

use super::QaUpdateMetadata;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureConfig {
    endpoint: String,
    install_root: PathBuf,
}

pub async fn check(
    app: AppHandle,
    webview: Webview,
    target: Option<String>,
) -> Result<Option<QaUpdateMetadata>, String> {
    if app.config().identifier != crate::QA_APP_ID {
        return Err("Updater QA requires the isolated QA application".into());
    }
    let data = crate::resolved_app_data_dir(&app)?;
    let config_path = data.join("updater-qa.json");
    if !config_path.exists() {
        return Ok(None);
    }
    if std::env::var_os("NEWMOB_DATA_DIR").is_none()
        || data.canonicalize().map_err(|e| e.to_string())? != data
        || data
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            != Some("native-appdata")
    {
        return Err("Updater QA requires a run-owned native profile".into());
    }
    let run_root = data
        .parent()
        .and_then(|p| p.parent())
        .ok_or("Invalid QA profile root")?;
    let config: FixtureConfig =
        serde_json::from_slice(&std::fs::read(&config_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let endpoint: url::Url = config
        .endpoint
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    if endpoint.scheme() != "http"
        || endpoint.host_str() != Some("127.0.0.1")
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err("Updater QA endpoint must be an unauthenticated IPv4 loopback URL".into());
    }
    let install_root = config
        .install_root
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if install_root != config.install_root
        || !install_root.starts_with(run_root)
        || install_root.file_name().and_then(|s| s.to_str()) != Some("Disposable.app")
        || std::env::current_exe()
            .map_err(|e| e.to_string())?
            .starts_with(&install_root)
    {
        return Err("Updater QA may only replace a disposable .app inside this run".into());
    }
    let target = target.unwrap_or_else(|| super::updater_platform().native_target);
    if !super::updater_platform().candidates.contains(&target) {
        return Err("Unsupported updater QA target".into());
    }
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .target(target)
        .executable_path(install_root.join("Contents/MacOS/taomni"))
        // The fixture uses authentic v0.4.29 signatures, including when QA is
        // built at that version or later. This comparator is QA-only.
        .version_comparator(|_, _| true)
        .timeout(Duration::from_secs(60))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    Ok(Some(QaUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}
