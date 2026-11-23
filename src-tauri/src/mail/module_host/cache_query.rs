//! Resolve the current account database and forward one bounded cache read.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    cache_query::{
        CacheQuery, CacheQueryRequest, MAX_CACHE_QUERY_BYTES, MAX_CACHE_REPLY_BYTES,
        QUERY_ACCOUNT_CACHE,
    },
    imap_exchange::{read_bounded_body_frame, write_body_frame},
};
use taomni_plugin_stream::routed_tcp::Route;

use super::{PluginRegistry, invoke, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn queries_account_cache(registry: &PluginRegistry) -> bool {
    supports(registry, QUERY_ACCOUNT_CACHE)
}

pub(in crate::mail) async fn query_account_cache<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account_id: String,
    query: CacheQuery,
) -> Result<T, String> {
    let encoded = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        serde_json::to_vec(&CacheQueryRequest {
            account_id,
            database,
            query,
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    if encoded.len() as u64 > MAX_CACHE_QUERY_BYTES {
        return Err("Mail cache query is too large".into());
    }

    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let transfer = async {
        let response = async {
            write_body_frame(&mut peer, &encoded).await?;
            read_bounded_body_frame(&mut peer, MAX_CACHE_REPLY_BYTES).await
        }
        .await;
        // If the host closes a rejected transfer, preserve the RPC error
        // instead of reporting just the resulting EOF.
        Ok::<_, String>(response)
    };
    let ((), response) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, QUERY_ACCOUNT_CACHE, endpoint),
            transfer
        )
    })
    .await
    .map_err(|_| "Mail cache query timed out".to_owned())??;
    let response = response.map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        serde_json::from_slice(&response).map_err(|_| "Invalid Mail cache query reply".to_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}
