//! Keep all desktop consumers on the same settings owner. An enabled older
//! package can keep using its legacy file until the new host adopts it.
use std::{fs, io, path::Path, sync::Arc, time::Duration};

use serde::{Serialize, de::DeserializeOwned};
use taomni_plugin_stream::{length_prefixed, routed_tcp::Route};
use taomni_sockscap_api::{SETTINGS, SLUG, SettingsRequest, SocksCapConfig};
use tauri::AppHandle;

use crate::plugin::{LifecycleState, PluginRegistry};

fn hosted(registry: &PluginRegistry) -> Result<bool, String> {
    if let Some(record) = registry.get(SLUG) {
        if record.state != LifecycleState::Enabled {
            return Err("Enable the SocksCap module to access its settings".into());
        }
        if record.manifest.commands.contains(SETTINGS) {
            return Ok(true);
        }
    }
    let retained = registry.root().join("sockscap/data/config.json");
    if retained.try_exists().map_err(|e| e.to_string())? {
        return Err("An updated SocksCap module is required to open the retained settings".into());
    }
    Ok(false)
}

fn legacy_seed(path: &Path) -> Result<SocksCapConfig, String> {
    let mut config: SocksCapConfig = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Read existing SocksCap settings: {e}"))?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => SocksCapConfig::default(),
        Err(error) => return Err(format!("Open existing SocksCap settings: {error}")),
    };
    config.normalize();
    Ok(config)
}

pub(super) async fn load(
    app: &AppHandle,
    registry: &Arc<PluginRegistry>,
) -> Result<SocksCapConfig, String> {
    if !hosted(registry)? {
        return Ok(SocksCapConfig::load(&super::config_path(app)?));
    }
    if let Some(owned) = exchange(registry, SETTINGS, SettingsRequest::Read).await? {
        return Ok(owned);
    }
    let path = super::config_path(app)?;
    let seed = tokio::task::spawn_blocking(move || legacy_seed(&path))
        .await
        .map_err(|e| e.to_string())??;
    exchange::<_, Option<SocksCapConfig>>(
        registry,
        SETTINGS,
        SettingsRequest::Adopt(Box::new(seed)),
    )
    .await?
    .ok_or_else(|| "SocksCap did not return the adopted settings".into())
}

pub(super) async fn save(
    app: &AppHandle,
    registry: &Arc<PluginRegistry>,
    config: &SocksCapConfig,
) -> Result<(), String> {
    if !hosted(registry)? {
        return config.save(&super::config_path(app)?);
    }
    exchange::<_, Option<SocksCapConfig>>(
        registry,
        SETTINGS,
        SettingsRequest::Save(Box::new(config.clone())),
    )
    .await?;
    Ok(())
}

pub(super) async fn exchange<Request: Serialize, Reply: DeserializeOwned>(
    registry: &Arc<PluginRegistry>,
    method: &'static str,
    request: Request,
) -> Result<Reply, String> {
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|e| e.to_string())?;
    let call = super::module_host::invoke::<()>(
        registry,
        method,
        serde_json::to_value(endpoint).map_err(|e| e.to_string())?,
    );
    let transfer = async {
        let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        length_prefixed::write(&mut peer, &bytes)
            .await
            .map_err(|e| e.to_string())?;
        let response = length_prefixed::read(&mut peer)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_slice(&response).map_err(|e| e.to_string())
    };
    let ((), config) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::try_join!(call, transfer)
    })
    .await
    .map_err(|_| "SocksCap settings request timed out".to_owned())??;
    Ok(config)
}
