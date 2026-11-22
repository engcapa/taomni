//! Decode an archived message using the signed host's MIME engine.

use std::sync::Arc;

use serde::Serialize;
use taomni_mail_api::{
    DECODE_ARCHIVE_ATTACHMENT, DECODE_ARCHIVE_ORIGINAL, HOST_REQUEST_TIMEOUT,
    archive::{ArchiveAttachmentDecoding, ArchiveDecoding},
    imap_exchange::{read_body_frame, write_body_frame},
    message::MailMessageBody,
};
use taomni_mail_engine::{
    cache::cached_to_body, extract_attachment, parse_body_message, storage::OpenMessage,
};
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};

use super::{PluginRegistry, invoke, supports};
use crate::mail::decode_mail_original;

pub(in crate::mail) async fn decode_archive_original(
    registry: Arc<PluginRegistry>,
    original: OpenMessage,
    account_id: String,
    folder: String,
    uid: u32,
) -> Result<MailMessageBody, String> {
    if !supports(&registry, DECODE_ARCHIVE_ORIGINAL) {
        return decode_mail_original(move || {
            let raw = original.read()?;
            Ok(cached_to_body(
                parse_body_message(
                    &account_id,
                    &folder,
                    uid,
                    Some(raw.len() as u32),
                    &raw,
                    raw.len(),
                ),
                "archive",
            ))
        })
        .await;
    }
    let reply = transfer_original(registry, original, DECODE_ARCHIVE_ORIGINAL, |exchange| {
        ArchiveDecoding {
            exchange,
            account_id: account_id.clone(),
            folder: folder.clone(),
            uid,
        }
    })
    .await?;
    let body: MailMessageBody = decode_mail_original(move || {
        serde_json::from_slice(&reply).map_err(|_| "Invalid Mail archive response".into())
    })
    .await?;
    if body.account_id != account_id
        || body.folder != folder
        || body.uid != uid
        || body.source != "archive"
    {
        return Err("Mail module returned another archived message".into());
    }
    Ok(body)
}

pub(in crate::mail) async fn decode_archive_attachment(
    registry: Arc<PluginRegistry>,
    original: OpenMessage,
    attachment_index: usize,
) -> Result<Vec<u8>, String> {
    if !supports(&registry, DECODE_ARCHIVE_ATTACHMENT) {
        return decode_mail_original(move || {
            let raw = original.read()?;
            Ok(extract_attachment(&raw, attachment_index)?.bytes)
        })
        .await;
    }
    transfer_original(registry, original, DECODE_ARCHIVE_ATTACHMENT, |exchange| {
        ArchiveAttachmentDecoding {
            exchange,
            attachment_index,
        }
    })
    .await
}

async fn transfer_original<P: Serialize + Send + 'static>(
    registry: Arc<PluginRegistry>,
    original: OpenMessage,
    method: &'static str,
    request: impl FnOnce(Endpoint) -> P,
) -> Result<Vec<u8>, String> {
    let raw = decode_mail_original(move || original.read()).await?;
    let (_route, exchange, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let transfer = async move {
        write_body_frame(&mut peer, &raw)
            .await
            .map_err(|error| error.to_string())?;
        drop(raw);
        read_body_frame(&mut peer)
            .await
            .map_err(|error| error.to_string())
    };
    let (_, reply) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, method, request(exchange)),
            transfer
        )
    })
    .await
    .map_err(|_| "Decoding the archived message timed out".to_owned())??;
    Ok(reply)
}
