//! Route archive index operations to the active signed host.

use std::{path::PathBuf, sync::Arc};

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    archive_index::{
        ArchiveIndexAction, ArchiveIndexRequest, ArchiveIndexSource, CLEANUP_ARCHIVE_INDEX,
        QUERY_ARCHIVE_INDEX,
    },
    imap_exchange::{read_body_frame, write_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::AsyncReadExt;

use super::{PluginRegistry, invoke, supports};
use crate::state::MailDbHandle;

pub(in crate::mail) fn queries_archive_index(registry: &PluginRegistry) -> bool {
    supports(registry, QUERY_ARCHIVE_INDEX)
}

pub(in crate::mail) fn cleans_archive_index(registry: &PluginRegistry) -> bool {
    supports(registry, CLEANUP_ARCHIVE_INDEX)
}

pub(in crate::mail) async fn query_archive_index<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account_id: String,
    account_cache: Option<MailDbHandle>,
    action: ArchiveIndexAction,
) -> Result<T, String> {
    run(
        registry,
        account_id,
        account_cache,
        action,
        QUERY_ARCHIVE_INDEX,
    )
    .await
}

pub(in crate::mail) async fn cleanup_archive_index<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account_id: String,
    account_cache: MailDbHandle,
    action: ArchiveIndexAction,
) -> Result<T, String> {
    run(
        registry,
        account_id,
        Some(account_cache),
        action,
        CLEANUP_ARCHIVE_INDEX,
    )
    .await
}

async fn run<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account_id: String,
    account_cache: Option<MailDbHandle>,
    action: ArchiveIndexAction,
    method: &'static str,
) -> Result<T, String> {
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let runtime = tokio::runtime::Handle::current();
    let transfer = async move {
        if peer.read_u8().await.map_err(|error| error.to_string())? != 1 {
            return Err("Invalid Mail archive index request".into());
        }
        tokio::task::spawn_blocking(move || {
            // Resolve redirects and initialize the schema before granting a route.
            let connection = account_cache
                .as_ref()
                .map(|cache| cache.lock())
                .transpose()?;
            let source = match &connection {
                Some(db) => {
                    let path = db.path().ok_or("Mail storage has no disk path")?;
                    let database = PathBuf::from(path)
                        .canonicalize()
                        .map_err(|error| format!("Resolve Mail archive index: {error}"))?;
                    ArchiveIndexSource::AccountCache { database }
                }
                None => ArchiveIndexSource::ModuleData,
            };
            // The read-only capability uses the caller's lease. The cleanup
            // capability acquires its own lease to cover the entire write.
            let _lease = if method == QUERY_ARCHIVE_INDEX {
                connection
            } else {
                drop(connection);
                None
            };
            let request = ArchiveIndexRequest {
                account_id,
                source,
                action,
            };
            let request = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
            let reply = runtime
                .block_on(async {
                    write_frame(&mut peer, &request).await?;
                    read_body_frame(&mut peer).await
                })
                .map_err(|error| error.to_string())?;
            serde_json::from_slice::<Result<T, String>>(&reply)
                .map_err(|_| "Invalid Mail archive index reply".to_owned())?
        })
        .await
        .map_err(|error| error.to_string())?
    };
    let ((), result) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(invoke::<(), _>(registry, method, endpoint), transfer)
    })
    .await
    .map_err(|_| "Mail archive index request timed out".to_owned())??;
    Ok(result)
}
