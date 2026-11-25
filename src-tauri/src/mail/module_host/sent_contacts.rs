use std::sync::Arc;

use taomni_mail_api::{
    compose::MailSendRequest,
    sent_contacts::{RECORD_SENT_CONTACTS, SentContactsUpdate},
};

use super::{PluginRegistry, cache_publication, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) async fn record_sent_contacts(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account_id: String,
    message: MailSendRequest,
) -> Result<usize, String> {
    let recipients: Vec<_> = message
        .to
        .into_iter()
        .chain(message.cc)
        .chain(message.bcc)
        .collect();
    if !supports(&registry, RECORD_SENT_CONTACTS) {
        #[cfg(feature = "legacy-mail-smtp")]
        if super::use_legacy_smtp(&registry) {
            return crate::mail::mail_db_task(cache, account_id, move |db, account| {
                taomni_mail_storage::cache::upsert_sent_contacts(
                    db,
                    account,
                    recipients.iter().map(String::as_str),
                )
            })
            .await;
        }
        return Err("Enable or update Mail in the module store to record sent contacts".into());
    }
    let request = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        serde_json::to_vec(&SentContactsUpdate {
            account_id,
            database,
            recipients,
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    cache_publication::send(registry, RECORD_SENT_CONTACTS, request).await
}
