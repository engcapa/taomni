//! Route parser operations to an installed SocksCap host.

use std::sync::Arc;

use serde_json::Value;
use taomni_sockscap_api::{
    PARSE_SHARE_LINK, SLUG,
    share_link::{self, ParsedShareLink},
};

use crate::plugin::{LifecycleState, PluginRegistry};

pub(super) async fn parse_share_link(
    registry: &Arc<PluginRegistry>,
    link: String,
) -> Result<ParsedShareLink, String> {
    let hosted = registry.get(SLUG).is_some_and(|record| {
        record.state == LifecycleState::Enabled
            && record.manifest.commands.contains(PARSE_SHARE_LINK)
    });
    // Leave room for JSON escaping and the decoded fields in one control frame.
    if !hosted || link.len() > crate::plugin::host::DEFAULT_MAX_FRAME_BYTES / 8 {
        return share_link::parse(&link);
    }

    let registry = registry.clone();
    tokio::task::spawn_blocking(move || {
        let response = registry
            .invoke(SLUG, PARSE_SHARE_LINK, Value::String(link))
            .map_err(|error| error.to_string())?;
        serde_json::from_value::<Result<ParsedShareLink, String>>(response)
            .map_err(|_| "Invalid SocksCap module response".to_owned())?
    })
    .await
    .map_err(|error| format!("SocksCap module task failed: {error}"))?
}
