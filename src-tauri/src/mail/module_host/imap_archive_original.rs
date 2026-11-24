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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, DuplexStream};

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
    receive(
        registry,
        READ_IMAP_ARCHIVE,
        request,
        async |receipt, peer| {
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
        },
    )
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
    save_attachment_reply(registry, READ_IMAP_ARCHIVE, request, target).await
}

pub(super) async fn save_attachment_reply(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    request: Vec<u8>,
    target: &Path,
) -> Result<Option<AttachmentReceipt>, String> {
    let result = receive(registry, method, request, async |receipt, peer| {
        let staging = stage_delivery(target, &receipt, peer).await?;
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

async fn stage_delivery(
    target: &Path,
    receipt: &AttachmentReceipt,
    peer: impl AsyncRead + Unpin,
) -> Result<tempfile::NamedTempFile, String> {
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
    check_length(receipt, size)?;
    file.flush().await.map_err(|error| error.to_string())?;
    file.sync_all().await.map_err(|error| error.to_string())?;
    Ok(staging)
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
    method: &'static str,
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
                .map_err(|_| "Invalid Mail file response".to_owned())?;
            match receipt {
                Some(receipt) => accept(receipt, peer).await.map(Some),
                None => Ok(None),
            }
        }
        .await;
        // Preserve the host's rejection if it also closes the stream.
        Ok::<_, String>(result)
    };
    let ((), result) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(invoke::<(), _>(registry, method, endpoint), transfer)
    })
    .await
    .map_err(|_| "Mail file transfer timed out".to_owned())??;
    result
}

fn check_length(receipt: &AttachmentReceipt, received: u64) -> Result<(), String> {
    if received != receipt.size as u64 {
        return Err("Mail module returned a different file size".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn incomplete_and_excess_payloads_leave_the_original_destination_available() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("attachment.bin");
        std::fs::write(&target, b"existing file").unwrap();
        let bytes: &[u8] = &[0, 0x7f, 0x80, 0xff];
        let mut receipt = AttachmentReceipt {
            name: None,
            content_type: Some("application/octet-stream".into()),
            size: bytes.len(),
        };
        for inaccurate in [3, 5] {
            receipt.size = inaccurate;
            assert!(stage_delivery(&target, &receipt, bytes).await.is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"existing file");
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }

        receipt.size = bytes.len();
        let staged = stage_delivery(&target, &receipt, bytes).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"existing file");
        staged.persist(&target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }
}
