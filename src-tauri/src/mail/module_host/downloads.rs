//! Receive Mail host downloads over the per-request authenticated route.

use std::{sync::Arc, time::Duration};

use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    FETCH_IMAP_ATTACHMENT, FETCH_IMAP_BODY, FETCH_IMAP_RAW, HOST_REQUEST_TIMEOUT, IncomingTest,
    imap_exchange::{
        AttachmentReceipt, AttachmentRequest, ImapExchange, RawMessageRequest, read_body_frame,
        read_frame, write_frame,
    },
};
use taomni_mail_engine::{
    DownloadedMailAttachment, MailMessageCached,
    imap_transport::{ImapBodyReply, ImapBodyRequest},
};
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};
use tokio::io::AsyncReadExt;

use super::{PluginRegistry, ResolvedMailAccount, decode_imap_reply, invoke_with_incoming};

pub(in crate::mail) async fn fetch_imap_raw(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    let (expected, bytes) = fetch_imap_download::<usize, _>(
        registry,
        account,
        FETCH_IMAP_RAW,
        |connection, exchange| RawMessageRequest {
            connection,
            exchange,
            folder: folder.to_owned(),
            uid,
        },
    )
    .await?;
    if bytes.len() != expected {
        return Err("Mail module returned an incomplete original message".into());
    }
    Ok(bytes)
}

pub(in crate::mail) async fn fetch_imap_attachment(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
    index: usize,
    section: Option<&str>,
) -> Result<DownloadedMailAttachment, String> {
    let (receipt, bytes) = fetch_imap_download::<AttachmentReceipt, _>(
        registry,
        account,
        FETCH_IMAP_ATTACHMENT,
        |connection, exchange| AttachmentRequest {
            connection,
            exchange,
            folder: folder.to_owned(),
            uid,
            index,
            section: section.map(str::to_owned),
        },
    )
    .await?;
    if bytes.len() != receipt.size {
        return Err("Mail module returned an incomplete attachment".into());
    }
    Ok(DownloadedMailAttachment {
        name: receipt.name,
        content_type: receipt.content_type,
        bytes,
    })
}

async fn fetch_imap_download<T: DeserializeOwned, P: Serialize + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    method: &'static str,
    request: impl FnOnce(IncomingTest, Endpoint) -> P,
) -> Result<(T, Vec<u8>), String> {
    let (_route, exchange, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let receive = async {
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes)
            .await
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(bytes)
    };
    let invoke = invoke_with_incoming(registry, account, method, |connection| {
        request(connection, exchange)
    });
    tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), async {
        tokio::try_join!(invoke, receive)
    })
    .await
    .map_err(|_| "Mail download timed out".to_owned())?
}

pub(in crate::mail) async fn fetch_imap_body(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
) -> Result<(MailMessageCached, Option<Vec<u8>>), String> {
    let request = ImapBodyRequest {
        account_id: account.config.session_id.clone(),
        folder: folder.to_owned(),
        uid,
        body_max_bytes: account.config.cache.body_max_bytes,
        save_original: account
            .config
            .cache
            .save_directory
            .as_deref()
            .is_some_and(|directory| !directory.trim().is_empty()),
    };
    let bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let (_route, exchange, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let receive = async {
        write_frame(&mut peer, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        let frame = read_body_frame(&mut peer)
            .await
            .map_err(|error| error.to_string())?;
        let reply: ImapBodyReply = decode_imap_reply(frame).await?;
        let header = &reply.message.header;
        if header.account_id != request.account_id || header.folder != folder || header.uid != uid {
            return Err("Mail module returned a different message".into());
        }
        let original = match reply.original_size {
            Some(size) if request.save_original => {
                let original = read_frame(&mut peer)
                    .await
                    .map_err(|error| error.to_string())?;
                if original.len() != size {
                    return Err("Mail module returned an incomplete original message".into());
                }
                Some(original)
            }
            Some(_) => return Err("Mail module returned an unsolicited original message".into()),
            None => None,
        };
        Ok((reply.message, original))
    };
    let invoke = invoke_with_incoming::<(), _>(registry, account, FETCH_IMAP_BODY, |connection| {
        ImapExchange {
            connection,
            exchange,
        }
    });
    let (_, result) = tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), async {
        tokio::try_join!(invoke, receive)
    })
    .await
    .map_err(|_| "Mail module IMAP body request timed out".to_owned())??;
    Ok(result)
}
