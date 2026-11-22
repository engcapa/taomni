use std::{path::Path, sync::Arc};

use taomni_mail_api::{
    ATTACHMENT_CACHE, HOST_REQUEST_TIMEOUT,
    attachment_cache::{AttachmentCacheRequest, AttachmentKey},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::{AsyncRead, AsyncWriteExt};

use super::{PluginRegistry, invoke};

pub(in crate::mail) async fn save_to_target(
    registry: Arc<PluginRegistry>,
    key: AttachmentKey,
    target: &Path,
) -> Result<Option<u64>, String> {
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    let mut destination = tokio::fs::File::from_std(staged.reopen().map_err(|e| e.to_string())?);
    let (_route, exchange, mut peer) = Route::pair().await.map_err(|e| e.to_string())?;
    let request = AttachmentCacheRequest {
        key,
        exchange,
        write_size: None,
    };
    let receive = async {
        tokio::io::copy(&mut peer, &mut destination)
            .await
            .map_err(|e| e.to_string())
    };
    let (size, received) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<Option<u64>, _>(registry, ATTACHMENT_CACHE, request),
            receive
        )
    })
    .await
    .map_err(|_| "Mail attachment cache read timed out")??;
    match size {
        None if received == 0 => Ok(None),
        Some(size) if received == size => {
            destination.sync_all().await.map_err(|e| e.to_string())?;
            drop(destination);
            staged
                .persist(target)
                .map_err(|error| error.error.to_string())?;
            Ok(Some(size))
        }
        _ => Err("Mail module returned an incomplete cached attachment".into()),
    }
}

pub(in crate::mail) async fn store(
    registry: Arc<PluginRegistry>,
    key: AttachmentKey,
    mut source: impl AsyncRead + Unpin,
    size: u64,
) -> Result<(), String> {
    let (_route, exchange, mut peer) = Route::pair().await.map_err(|e| e.to_string())?;
    let request = AttachmentCacheRequest {
        key,
        exchange,
        write_size: Some(size),
    };
    let send = async {
        let sent = tokio::io::copy(&mut source, &mut peer)
            .await
            .map_err(|e| e.to_string())?;
        peer.shutdown().await.map_err(|e| e.to_string())?;
        Ok::<_, String>(sent)
    };
    let (stored, sent) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<Option<u64>, _>(registry, ATTACHMENT_CACHE, request),
            send
        )
    })
    .await
    .map_err(|_| "Mail attachment cache write timed out")??;
    if stored == Some(size) && sent == size {
        Ok(())
    } else {
        Err("Incomplete Mail attachment cache write".into())
    }
}
