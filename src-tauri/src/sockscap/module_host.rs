//! Route SocksCap control operations to the installed host.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;
use taomni_sockscap_api::{
    PARSE_SHARE_LINK, SLUG, TEST_SAVED_TARGET, TEST_TARGET,
    policy::{SavedTargetReply, SavedTargetRequest, TargetRuleProbe, TargetTestResult},
    share_link::{self, ParsedShareLink},
};
use tauri::AppHandle;

use super::{module_rules, module_settings};
use crate::plugin::{LifecycleState, PluginRegistry};

pub(super) async fn parse_share_link(
    registry: &Arc<PluginRegistry>,
    link: String,
) -> Result<ParsedShareLink, String> {
    // Leave room for JSON escaping and the decoded fields in one control frame.
    if !supports(registry, PARSE_SHARE_LINK)
        || link.len() > crate::plugin::host::DEFAULT_MAX_FRAME_BYTES / 8
    {
        return share_link::parse(&link);
    }
    invoke(registry, PARSE_SHARE_LINK, Value::String(link)).await?
}

pub(super) async fn test_target(
    registry: &Arc<PluginRegistry>,
    probe: TargetRuleProbe,
) -> Result<TargetTestResult, String> {
    if !supports(registry, TEST_TARGET) {
        return Ok(probe.evaluate());
    }
    let payload = serde_json::to_value(&probe).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    if bytes.len() > crate::plugin::host::DEFAULT_MAX_FRAME_BYTES / 2 {
        return Ok(probe.evaluate());
    }
    invoke(registry, TEST_TARGET, payload).await
}

/// Returns no result only for packages that predate host-owned evaluation.
pub(super) async fn test_saved_target(
    app: &AppHandle,
    registry: &Arc<PluginRegistry>,
    host: &str,
    port: u16,
) -> Result<Option<TargetTestResult>, String> {
    if !supports(registry, TEST_SAVED_TARGET) {
        return Ok(None);
    }
    let mut request = SavedTargetRequest {
        host: host.into(),
        port,
        legacy_rules_checked: false,
    };
    let (settings_missing, rules_missing) =
        match module_settings::exchange(registry, TEST_SAVED_TARGET, &request).await? {
            SavedTargetReply::Evaluated { result } => return Ok(Some(result)),
            SavedTargetReply::Adopt {
                settings_missing,
                rules_missing,
            } => (settings_missing, rules_missing),
        };
    if settings_missing {
        module_settings::load(app, registry).await?;
    }
    if rules_missing {
        module_rules::adopt_missing(app, registry).await?;
        request.legacy_rules_checked = true;
    }
    match module_settings::exchange(registry, TEST_SAVED_TARGET, request).await? {
        SavedTargetReply::Evaluated { result } => Ok(Some(result)),
        SavedTargetReply::Adopt { .. } => {
            Err("SocksCap settings are unavailable after adoption".into())
        }
    }
}

fn supports(registry: &PluginRegistry, command: &str) -> bool {
    registry.get(SLUG).is_some_and(|record| {
        record.state == LifecycleState::Enabled && record.manifest.commands.contains(command)
    })
}

pub(super) async fn invoke<T: DeserializeOwned + Send + 'static>(
    registry: &Arc<PluginRegistry>,
    command: &'static str,
    payload: Value,
) -> Result<T, String> {
    let registry = registry.clone();
    tokio::task::spawn_blocking(move || {
        let response = registry
            .invoke(SLUG, command, payload)
            .map_err(|error| error.to_string())?;
        serde_json::from_value::<T>(response)
            .map_err(|_| "Invalid SocksCap module response".to_owned())
    })
    .await
    .map_err(|error| format!("SocksCap module task failed: {error}"))?
}
