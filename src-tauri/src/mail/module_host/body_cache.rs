//! Give the signed Mail host one account's decoded message and cache path.

use std::sync::Arc;

use taomni_mail_api::{
    body_cache::{ImapBodyCacheSource, ImapBodyPublication, PUBLISH_IMAP_BODY_CACHE},
    message::MailMessageCached,
};

use super::{PluginRegistry, cache_publication, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn publishes_body_cache(registry: &PluginRegistry) -> bool {
    supports(registry, PUBLISH_IMAP_BODY_CACHE)
}

pub(in crate::mail) async fn publish_body_cache(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account_id: String,
    message: MailMessageCached,
    observed_at: i64,
    source: ImapBodyCacheSource,
) -> Result<(bool, MailMessageCached), String> {
    let (request, message) = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        let request = serde_json::to_vec(&ImapBodyPublication {
            database,
            account_id,
            observed_at,
            source,
            message: &message,
        })
        .map_err(|error| error.to_string())?;
        Ok::<_, String>((request, message))
    })
    .await
    .map_err(|error| error.to_string())??;
    let applied = cache_publication::send(registry, PUBLISH_IMAP_BODY_CACHE, request).await?;
    Ok((applied, message))
}
