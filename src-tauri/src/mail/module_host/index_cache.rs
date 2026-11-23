//! Pass the completed folder operation to the signed Mail cache writer.

use std::sync::Arc;

use taomni_mail_api::imap_index::{
    AppliedStep, ImapIndexAction, ImapIndexPublication, ImapIndexRetention, PUBLISH_IMAP_INDEX,
};

use super::{PluginRegistry, cache_publication, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn publishes_imap_index(registry: &PluginRegistry) -> bool {
    supports(registry, PUBLISH_IMAP_INDEX)
}

pub(in crate::mail) async fn publish_imap_index(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account_id: String,
    retention: ImapIndexRetention,
    started_at_ms: i64,
    action: ImapIndexAction,
) -> Result<(Option<AppliedStep>, ImapIndexAction), String> {
    let (request, action) = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        let request = serde_json::to_vec(&ImapIndexPublication {
            account_id,
            database,
            retention,
            started_at_ms,
            action: &action,
        })
        .map_err(|error| error.to_string())?;
        Ok::<_, String>((request, action))
    })
    .await
    .map_err(|error| error.to_string())??;
    let receipt = cache_publication::send(registry, PUBLISH_IMAP_INDEX, request).await?;
    Ok((receipt, action))
}
