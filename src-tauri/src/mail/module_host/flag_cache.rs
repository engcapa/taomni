//! Commit confirmed remote flags via the installed Mail writer.

use std::sync::Arc;

use taomni_mail_api::imap_flag_cache::{
    ImapFlagCacheAction, ImapFlagPublication, PUBLISH_IMAP_FLAG_CACHE,
};

use super::{PluginRegistry, cache_publication, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn publishes_imap_flags(registry: &PluginRegistry) -> bool {
    supports(registry, PUBLISH_IMAP_FLAG_CACHE)
}

pub(in crate::mail) async fn publish_imap_flags(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account_id: String,
    action: ImapFlagCacheAction,
) -> Result<(), String> {
    let request = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        serde_json::to_vec(&ImapFlagPublication {
            account_id,
            database,
            action,
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    cache_publication::send(registry, PUBLISH_IMAP_FLAG_CACHE, request).await
}
