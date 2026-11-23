//! Receive archived IMAP messages and save complete exports to user destinations.

use std::{path::Path, sync::Arc};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    archive_original::{
        ImapArchiveAction, ImapArchiveRequest, MAX_ARCHIVE_ORIGINAL_REQUEST,
        MAX_ARCHIVE_READER_BYTES, READ_IMAP_ARCHIVE,
    },
    imap_exchange::{AttachmentReceipt, read_bounded_body_frame, write_body_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use super::{PluginRegistry, invoke, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn supported(registry: &PluginRegistry) -> bool {
    supports(registry, READ_IMAP_ARCHIVE)
}

pub(in crate::mail) async fn fetch_raw(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<String>, String> {
    let request = request(cache, account, folder, uid, ImapArchiveAction::ViewSource).await?;
    receive(registry, request, async |receipt, peer| {
        if receipt.size as u64 > MAX_ARCHIVE_READER_BYTES {
            return Err("Mail archive reader received an oversized original".into());
        }
        let mut raw = Vec::new();
        let size = peer
            .take(receipt.size as u64 + 1)
            .read_to_end(&mut raw)
            .await
            .map_err(|error| error.to_string())?;
        check_length(&receipt, size as u64)?;
        tokio::task::spawn_blocking(move || String::from_utf8_lossy(&raw).into_owned())
            .await
            .map_err(|error| error.to_string())
    })
    .await
}

pub(in crate::mail) async fn save(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account: &str,
    folder: &str,
    uid: u32,
    action: ImapArchiveAction,
    target: &Path,
) -> Result<Option<AttachmentReceipt>, String> {
    let request = request(cache, account, folder, uid, action).await?;
    let result = receive(registry, request, async |receipt, peer| {
        let parent = target
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
        let staging = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        let file = staging.reopen().map_err(|error| error.to_string())?;
        let mut file = tokio::fs::File::from_std(file);
        let mut source = peer.take((receipt.size as u64).saturating_add(1));
        let size = tokio::io::copy(&mut source, &mut file)
            .await
            .map_err(|error| error.to_string())?;
        check_length(&receipt, size)?;
        file.flush().await.map_err(|error| error.to_string())?;
        file.sync_all().await.map_err(|error| error.to_string())?;
        Ok((staging, receipt))
    })
    .await?;
    let Some((staging, receipt)) = result else {
        return Ok(None);
    };
    staging
        .persist(target)
        .map_err(|error| error.error.to_string())?;
    Ok(Some(receipt))
}

async fn request(
    cache: MailDbHandle,
    account: &str,
    folder: &str,
    uid: u32,
    action: ImapArchiveAction,
) -> Result<Vec<u8>, String> {
    let database = tokio::task::spawn_blocking(move || canonical_cache_database(&cache))
        .await
        .map_err(|error| error.to_string())??;
    let encoded = serde_json::to_vec(&ImapArchiveRequest {
        database,
        account_id: account.to_owned(),
        folder: folder.to_owned(),
        uid,
        action,
    })
    .map_err(|error| error.to_string())?;
    if encoded.len() as u64 > MAX_ARCHIVE_ORIGINAL_REQUEST {
        return Err("Mail archive request is too large".into());
    }
    Ok(encoded)
}

async fn receive<T>(
    registry: Arc<PluginRegistry>,
    request: Vec<u8>,
    accept: impl AsyncFnOnce(AttachmentReceipt, DuplexStream) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let transfer = async {
        let result = async {
            write_body_frame(&mut peer, &request)
                .await
                .map_err(|error| error.to_string())?;
            let header = read_bounded_body_frame(&mut peer, MAX_ARCHIVE_ORIGINAL_REQUEST)
                .await
                .map_err(|error| error.to_string())?;
            let receipt = serde_json::from_slice::<Option<AttachmentReceipt>>(&header)
                .map_err(|_| "Invalid Mail archive response".to_owned())?;
            match receipt {
                Some(receipt) => accept(receipt, peer).await.map(Some),
                None => Ok(None),
            }
        }
        .await;
        // Keep the host's archive error if its rejection also closes the stream.
        Ok::<_, String>(result)
    };
    let ((), result) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, READ_IMAP_ARCHIVE, endpoint),
            transfer
        )
    })
    .await
    .map_err(|_| "Mail archive read timed out".to_owned())??;
    result
}

fn check_length(receipt: &AttachmentReceipt, received: u64) -> Result<(), String> {
    if received != receipt.size as u64 {
        return Err("Mail module returned a different archived file size".into());
    }
    Ok(())
}
