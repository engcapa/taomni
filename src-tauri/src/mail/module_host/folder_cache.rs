//! Publish an IMAP folder result through the host that owns the update.

use std::{path::Path, sync::Arc};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    folder_cache::{FolderCacheAction, FolderCacheUpdate, UPDATE_IMAP_FOLDER_CACHE},
    imap_exchange::{read_body_frame, write_frame},
};
use taomni_plugin_stream::routed_tcp::Route;

use super::{MailFolder, PluginRegistry, invoke, supports};
use crate::state::MailDbHandle;

pub(in crate::mail) fn publishes_folder_cache(registry: &PluginRegistry) -> bool {
    supports(registry, UPDATE_IMAP_FOLDER_CACHE)
}

pub(in crate::mail) async fn update_folder_cache(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account_id: String,
    action: FolderCacheAction,
    folders: Vec<MailFolder>,
) -> Result<Vec<MailFolder>, String> {
    let request = tokio::task::spawn_blocking(move || {
        let database = {
            let db = cache.lock()?;
            Path::new(db.path().ok_or("Mail storage has no disk path")?)
                .canonicalize()
                .map_err(|error| error.to_string())?
        };
        serde_json::to_vec(&FolderCacheUpdate {
            account_id,
            database,
            action,
            folders,
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
    let ((), reply) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, UPDATE_IMAP_FOLDER_CACHE, endpoint),
            transfer
        )
    })
    .await
    .map_err(|_| "Mail folder cache update timed out".to_owned())??;
    tokio::task::spawn_blocking(move || {
        serde_json::from_slice(&reply).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
