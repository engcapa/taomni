//! Write a signed Mail export stream to the user-selected destination.

use std::{path::Path, sync::Arc, time::Duration};

use taomni_mail_api::{
    EXPORT_IMAP_MBOX, HOST_REQUEST_TIMEOUT,
    imap_exchange::{ExportMailbox, MBOX_EXPORT_FRAME_BYTES, read_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::{AsyncRead, AsyncWriteExt};

use super::{
    PluginRegistry, ResolvedMailAccount, bind_incoming, decode_imap_reply, invoke, supports,
};

pub(in crate::mail) fn exports_imap_mbox(registry: &PluginRegistry) -> bool {
    supports(registry, EXPORT_IMAP_MBOX)
}

pub(in crate::mail) async fn export_imap_mbox(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    folder: String,
    target: &Path,
) -> Result<usize, String> {
    let parent = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let create_error = |error| format!("cannot create {}: {error}", target.display());
    let stage = tempfile::NamedTempFile::new_in(parent).map_err(create_error)?;
    let file = stage.reopen().map_err(create_error)?;
    let mut file = tokio::fs::File::from_std(file);
    let (_incoming, connection) = bind_incoming(account).await?;
    let (_exchange, exchange, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    invoke::<(), _>(
        registry,
        EXPORT_IMAP_MBOX,
        ExportMailbox {
            connection,
            exchange,
            folder,
        },
    )
    .await?;
    let write_error = |error| format!("writing mbox failed: {error}");
    loop {
        let frame = next_frame(&mut peer).await?;
        if frame.is_empty() {
            break;
        }
        if frame.len() > MBOX_EXPORT_FRAME_BYTES {
            return Err("Mail export returned an oversized chunk".into());
        }
        file.write_all(&frame).await.map_err(write_error)?;
    }
    let count = decode_imap_reply(next_frame(&mut peer).await?).await?;
    file.flush().await.map_err(write_error)?;
    file.sync_all().await.map_err(write_error)?;
    drop(file);
    stage
        .persist(target)
        .map_err(|error| write_error(error.error))?;
    Ok(count)
}

async fn next_frame(peer: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>, String> {
    tokio::time::timeout(
        HOST_REQUEST_TIMEOUT + Duration::from_secs(5),
        read_frame(peer),
    )
    .await
    .map_err(|_| "Mail export timed out".to_owned())?
    .map_err(|error| format!("reading Mail export failed: {error}"))
}
