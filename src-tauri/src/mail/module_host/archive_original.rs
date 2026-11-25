//! Stream archived originals from signed Mail without granting it a save path.

use std::{path::Path, sync::Arc};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    archive_index::ArchiveEntry,
    archive_original::{
        ArchiveOriginalRequest, MAX_ARCHIVE_ORIGINAL_REQUEST, OPEN_ARCHIVE_ORIGINAL,
    },
    imap_exchange::{read_body_frame, write_body_frame},
    message::MailMessageBody,
    pop3_store::LocalArchiveAction,
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::timeout,
};

use super::{PluginRegistry, invoke, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn opens_archive_original(registry: &PluginRegistry) -> bool {
    supports(registry, OPEN_ARCHIVE_ORIGINAL)
}

pub(in crate::mail) async fn read_archive_original(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account: String,
    entry: ArchiveEntry,
) -> Result<MailMessageBody, String> {
    let folder = entry.folder.clone();
    let uid = entry.uid;
    let encoded = request(cache, account.clone(), LocalArchiveAction::Read { entry }).await?;
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let exchange = async {
        let reply = async {
            write_body_frame(&mut peer, &encoded).await?;
            read_body_frame(&mut peer).await
        }
        .await;
        Ok::<_, String>(reply)
    };
    let ((), reply) = timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, OPEN_ARCHIVE_ORIGINAL, endpoint),
            exchange
        )
    })
    .await
    .map_err(|_| "Mail archive read timed out".to_owned())??;
    let reply = reply.map_err(|error| error.to_string())?;
    let body: MailMessageBody = tokio::task::spawn_blocking(move || serde_json::from_slice(&reply))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "Invalid Mail archive response".to_owned())?;
    if body.account_id != account
        || body.folder != folder
        || body.uid != uid
        || body.source != "archive"
    {
        return Err("Mail module returned another archived message".into());
    }
    Ok(body)
}

pub(in crate::mail) async fn export_archive_original(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account: String,
    entry: ArchiveEntry,
    attachment_index: Option<usize>,
    target: &Path,
) -> Result<(), String> {
    let action = LocalArchiveAction::Export {
        entry,
        attachment_index,
    };
    let encoded = request(cache, account, action).await?;
    save_export(registry, OPEN_ARCHIVE_ORIGINAL, encoded, target).await
}

async fn request(
    cache: MailDbHandle,
    account_id: String,
    action: LocalArchiveAction,
) -> Result<Vec<u8>, String> {
    let encoded = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        serde_json::to_vec(&ArchiveOriginalRequest {
            account_id,
            database,
            action,
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    if encoded.len() as u64 > MAX_ARCHIVE_ORIGINAL_REQUEST {
        return Err("Mail archive request is too large".into());
    }
    Ok(encoded)
}

pub(super) async fn save_export(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    encoded: Vec<u8>,
    target: &Path,
) -> Result<(), String> {
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| error.to_string())?;
    let staging = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    let mut file = tokio::fs::File::from_std(staging.reopen().map_err(|error| error.to_string())?);
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let exchange = async {
        let transfer = async {
            write_body_frame(&mut peer, &encoded).await?;
            let length = peer.read_u64().await?;
            let copied = tokio::io::copy(&mut peer.take(length), &mut file).await?;
            if length != copied {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Incomplete archived original",
                ));
            }
            file.flush().await?;
            file.sync_all().await
        }
        .await;
        Ok::<_, String>(transfer)
    };
    let ((), transfer) = timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(invoke::<(), _>(registry, method, endpoint), exchange)
    })
    .await
    .map_err(|_| "Mail archive export timed out".to_owned())??;
    transfer.map_err(|error| error.to_string())?;
    drop(file);
    staging
        .persist(target)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}
