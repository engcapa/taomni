//! Decode an archived message using the signed host's MIME engine.

use std::sync::Arc;

use serde::Serialize;
use taomni_mail_api::{
    DECODE_ARCHIVE_ATTACHMENT, DECODE_ARCHIVE_ORIGINAL,
    archive::{ArchiveAttachmentDecoding, ArchiveDecoding},
    message::MailMessageBody,
};
use taomni_mail_storage::storage::OpenMessage;
use taomni_plugin_stream::routed_tcp::Endpoint;

use super::{PluginRegistry, mime_exchange::transform, supports};
#[cfg(feature = "legacy-mail-imap")]
use crate::mail::legacy_archive_without_host;
use crate::mail::{SIGNED_MAIL_ARCHIVE_REQUIRED, decode_mail_original};

#[cfg(feature = "legacy-mail-imap")]
use taomni_mail_storage::{cache::cached_to_body, extract_attachment, parse_body_message};

pub(in crate::mail) async fn decode_archive_original(
    registry: Arc<PluginRegistry>,
    original: OpenMessage,
    account_id: String,
    folder: String,
    uid: u32,
) -> Result<MailMessageBody, String> {
    #[cfg(feature = "legacy-mail-imap")]
    if legacy_archive_without_host(&registry) {
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
    #[cfg(feature = "legacy-mail-imap")]
    if legacy_archive_without_host(&registry) {
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
    if !supports(&registry, method) {
        return Err(SIGNED_MAIL_ARCHIVE_REQUIRED.into());
    }
    let raw = decode_mail_original(move || original.read()).await?;
    transform(
        registry,
        method,
        raw,
        request,
        "Decoding the archived message timed out",
    )
    .await
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use taomni_mail_storage::{cache::init_mail_tables, storage};

    use super::*;

    #[tokio::test]
    async fn archive_without_a_host_uses_the_explicit_legacy_feature_and_retains_the_original() {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path().canonicalize().unwrap();
        let registry = Arc::new(PluginRegistry::new(root.join("plugins")));
        let account = "archive-test";
        let folder = "INBOX";
        let uid = 3;
        let raw = concat!(
            "Subject: Saved from the monolith\r\nContent-Type: multipart/mixed; boundary=mail\r\n\r\n",
            "--mail\r\nContent-Type: text/plain\r\n\r\nOriginal body\r\n",
            "--mail\r\nContent-Type: application/octet-stream\r\n",
            "Content-Disposition: attachment; filename=retained.txt\r\n\r\nOriginal attachment\r\n",
            "--mail--\r\n",
        )
        .as_bytes();
        let db = Connection::open(root.join("mail.db")).unwrap();
        init_mail_tables(&db).unwrap();
        storage::store(&db, account, folder, uid, 1, raw).unwrap();
        let open = || storage::open(&db, account, folder, uid).unwrap().unwrap();

        let body =
            decode_archive_original(registry.clone(), open(), account.into(), folder.into(), uid)
                .await;
        let attachment = decode_archive_attachment(registry, open(), 0).await;
        #[cfg(not(feature = "legacy-mail-imap"))]
        {
            assert_eq!(body.err().as_deref(), Some(SIGNED_MAIL_ARCHIVE_REQUIRED));
            assert_eq!(attachment, Err(SIGNED_MAIL_ARCHIVE_REQUIRED.into()));
        }
        #[cfg(feature = "legacy-mail-imap")]
        {
            assert_eq!(body.unwrap().subject, "Saved from the monolith");
            assert_eq!(attachment.unwrap(), b"Original attachment");
        }
        assert_eq!(open().read().unwrap(), raw);
    }
}
