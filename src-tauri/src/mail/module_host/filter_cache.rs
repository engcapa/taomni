//! Use the installed host to select IMAP filter candidates and commit progress.

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    filter_cache::{
        FilterCacheAction, FilterCandidates, IMAP_FILTER_CACHE, ImapFilterCacheRequest,
    },
    imap_exchange::{read_body_frame, write_frame},
};
use taomni_plugin_stream::routed_tcp::Route;

use super::{PluginRegistry, invoke, supports};
use crate::{mail::cache_access::canonical_cache_database, state::AppState};

pub(in crate::mail) fn owns_imap_filter_cache(registry: &PluginRegistry) -> bool {
    supports(registry, IMAP_FILTER_CACHE)
}

pub(in crate::mail) async fn imap_filter_cache(
    state: &AppState,
    account_id: &str,
    action: FilterCacheAction,
) -> Result<Option<FilterCandidates>, String> {
    let cache = state.mail_db(account_id)?;
    let account_id = account_id.to_owned();
    let request = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        serde_json::to_vec(&ImapFilterCacheRequest {
            account_id,
            database,
            action,
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let transfer = async {
        write_frame(&mut peer, &request)
            .await
            .map_err(|error| error.to_string())?;
        read_body_frame(&mut peer)
            .await
            .map_err(|error| error.to_string())
    };
    let ((), bytes) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(state.plugins.clone(), IMAP_FILTER_CACHE, endpoint),
            transfer
        )
    })
    .await
    .map_err(|_| "Mail filter cache request timed out".to_owned())??;
    tokio::task::spawn_blocking(move || {
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
