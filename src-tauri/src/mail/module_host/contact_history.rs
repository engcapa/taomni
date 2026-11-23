use std::sync::Arc;

use serde::de::DeserializeOwned;
use taomni_mail_api::contact_history::{
    CONTACT_HISTORY, ContactHistoryAction, ContactHistoryRequest,
};

use super::{PluginRegistry, cache_publication, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn manages_contact_history(registry: &PluginRegistry) -> bool {
    supports(registry, CONTACT_HISTORY)
}

pub(in crate::mail) async fn contact_history<T: DeserializeOwned>(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account_id: String,
    action: ContactHistoryAction,
) -> Result<T, String> {
    let request = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        serde_json::to_vec(&ContactHistoryRequest {
            account_id,
            database,
            action,
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    cache_publication::send(registry, CONTACT_HISTORY, request).await
}
