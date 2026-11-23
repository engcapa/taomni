//! Send only the MIME bytes selected by the scanner. The host receives no
//! paths. Check its output against the input before publishing any archive row.
use std::{
    fs::File,
    io::{Read, Seek},
    sync::Arc,
    time::Duration,
};

use sha2::{Digest, Sha256};
use taomni_mail_api::{
    ENCODE_ARCHIVE_ORIGINAL, HOST_REQUEST_TIMEOUT,
    archive::{ARCHIVE_FRAME_BYTES, ArchiveEncoding, PUBLISH_IMAP_ARCHIVE, receive_encoding},
    archive_index::ArchiveKey,
};
use taomni_mail_engine::{
    archive::{
        MessageObject,
        progress::ScanProgress,
        verify_encoded_original,
        writer::{ArchiveMailbox, OriginalEncoder},
    },
    storage::PreparedMessage,
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    runtime::Handle,
};

use super::{PluginRegistry, invoke, supports};

pub(in crate::mail) struct ArchiveEncoder<'a> {
    runtime: &'a Handle,
    registry: &'a Arc<PluginRegistry>,
}

impl<'a> ArchiveEncoder<'a> {
    pub(in crate::mail) fn for_registry(
        runtime: &'a Handle,
        registry: &'a Arc<PluginRegistry>,
    ) -> Option<Self> {
        supports(registry, ENCODE_ARCHIVE_ORIGINAL).then_some(Self { runtime, registry })
    }
}

impl OriginalEncoder for ArchiveEncoder<'_> {
    fn encode(
        &self,
        input: &mut dyn Read,
        size: u64,
        output: &mut File,
        progress: &ScanProgress,
    ) -> Result<MessageObject, String> {
        let (checksum, object) = self.runtime.block_on(async {
            let stream = async {
                let (_guard, exchange, peer) = Route::pair().await.map_err(|e| e.to_string())?;
                invoke::<(), _>(
                    self.registry.clone(),
                    ENCODE_ARCHIVE_ORIGINAL,
                    ArchiveEncoding {
                        exchange,
                        raw_size: size,
                    },
                )
                .await?;
                let (reader, writer) = tokio::io::split(peer);
                tokio::try_join!(
                    send_original(input, size, writer),
                    receive_encoding(output, size, reader, HOST_REQUEST_TIMEOUT)
                )
            };
            let pause = async {
                loop {
                    progress.update(|_| {})?;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            };
            tokio::select! { biased; error = pause => error, result = stream => result }
        })?;
        output.rewind().map_err(|e| e.to_string())?;
        verify_encoded_original(output, &object, &checksum, size, || progress.update(|_| {}))?;
        Ok(object)
    }

    fn publish_imap(
        &self,
        mailbox: &ArchiveMailbox<'_>,
        target: &ArchiveKey,
        prepared: PreparedMessage,
    ) -> Result<(), String> {
        if !supports(self.registry, PUBLISH_IMAP_ARCHIVE) {
            return mailbox.publish_prepared(target, prepared);
        }
        super::archive_publication::publish(
            self.runtime,
            self.registry.clone(),
            mailbox,
            target,
            prepared,
        )
    }
}

async fn send_original(
    input: &mut dyn Read,
    size: u64,
    mut writer: impl AsyncWrite + Unpin,
) -> Result<String, String> {
    let mut digest = Sha256::new();
    let mut sent = 0_u64;
    let mut buffer = vec![0; ARCHIVE_FRAME_BYTES];
    loop {
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        sent += count as u64;
        if sent > size {
            return Err("Mail archive original grew during encoding".into());
        }
        digest.update(&buffer[..count]);
        tokio::time::timeout(HOST_REQUEST_TIMEOUT, writer.write_all(&buffer[..count]))
            .await
            .map_err(|_| "Mail archive upload stalled".to_string())?
            .map_err(|e| e.to_string())?;
    }
    if sent != size {
        return Err("Mail archive original ended early".into());
    }
    Ok(hex::encode(digest.finalize()))
}
