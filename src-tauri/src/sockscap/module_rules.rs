//! Route rule cache reads and writes to the signed host when it owns the data.

use std::{path::PathBuf, sync::Arc};

use taomni_sockscap_api::{RULES, RulesRequest, SLUG, gfwlist_rules::RuleCache};
use tauri::AppHandle;

use super::{
    module_settings::exchange,
    rules::{CompiledRules, source},
};
use crate::plugin::{LifecycleState, PluginRegistry};

fn hosted(registry: &PluginRegistry) -> Result<bool, String> {
    let Some(record) = registry.get(SLUG) else {
        return Ok(false);
    };
    if record.state != LifecycleState::Enabled || record.reason.is_some() {
        return Err("Enable SocksCap to access its rules".into());
    }
    Ok(record.manifest.commands.contains(RULES))
}

pub(super) async fn load(
    app: &AppHandle,
    registry: &Arc<PluginRegistry>,
) -> Result<Option<CompiledRules>, String> {
    let hosted = hosted(registry)?;
    if hosted {
        let current: Option<RuleCache> = exchange(registry, RULES, RulesRequest::Read).await?;
        if let Some(cache) = current {
            return tokio::task::spawn_blocking(move || cache.compile().map(Some))
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    let legacy = super::rules_dir(app)?;
    let previous = tokio::task::spawn_blocking(move || source::load_legacy(&legacy))
        .await
        .map_err(|error| error.to_string())?;
    let Some(previous) = previous else {
        return Ok(None);
    };
    if !hosted {
        return Ok(previous.compile().ok());
    }
    let adopted: Option<RuleCache> =
        exchange(registry, RULES, RulesRequest::Adopt(previous)).await?;
    let cache = adopted.ok_or("SocksCap did not return the adopted rule cache")?;
    tokio::task::spawn_blocking(move || cache.compile().map(Some))
        .await
        .map_err(|error| error.to_string())?
}

pub(super) async fn refresh(
    app: &AppHandle,
    registry: &Arc<PluginRegistry>,
    url: &str,
) -> Result<CompiledRules, String> {
    let hosted = hosted(registry)?;
    let (raw, etag) = source::fetch(url).await?;
    replace(app, registry, hosted, raw, url.trim().to_owned(), etag).await
}

pub(super) async fn import(
    app: &AppHandle,
    registry: &Arc<PluginRegistry>,
    path: PathBuf,
) -> Result<CompiledRules, String> {
    let hosted = hosted(registry)?;
    let source = format!("file:{}", path.display());
    let raw = tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("read rules file: {error}"))?;
    replace(app, registry, hosted, raw, source, None).await
}

async fn replace(
    app: &AppHandle,
    registry: &Arc<PluginRegistry>,
    hosted: bool,
    raw: String,
    name: String,
    etag: Option<String>,
) -> Result<CompiledRules, String> {
    let (cache, compiled) = tokio::task::spawn_blocking(move || {
        let mut compiled = CompiledRules::compile(&raw, &name)?;
        compiled.meta.etag = etag;
        let cache = RuleCache {
            raw,
            meta: compiled.meta.clone(),
        };
        Ok::<_, String>((cache, compiled))
    })
    .await
    .map_err(|error| error.to_string())??;
    if hosted {
        exchange::<_, Option<RuleCache>>(registry, RULES, RulesRequest::Replace(cache)).await?;
    } else {
        let dir = super::rules_dir(app)?;
        tokio::task::spawn_blocking(move || source::save_legacy(&dir, &cache))
            .await
            .map_err(|error| error.to_string())??;
    }
    Ok(compiled)
}
