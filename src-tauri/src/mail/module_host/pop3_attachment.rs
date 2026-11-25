//! Save a POP3 attachment supplied by the signed Mail host.

use std::{path::Path, sync::Arc};

use taomni_mail_api::{
    archive_original::MAX_ARCHIVE_ORIGINAL_REQUEST,
    imap_exchange::AttachmentReceipt,
    pop3_store::{Pop3AttachmentRequest, READ_POP3_ATTACHMENT},
};

use super::{PluginRegistry, imap_archive_original::save_attachment_reply, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) async fn save(
    registry: Arc<PluginRegistry>,
    cache: Option<MailDbHandle>,
    account: &str,
    folder: &str,
    uid: u32,
    index: usize,
    target: &Path,
) -> Result<AttachmentReceipt, String> {
    if !supports(&registry, READ_POP3_ATTACHMENT) {
        return Err("Enable or update Mail in the module store to save this attachment".into());
    }
    let legacy_database = match cache {
        Some(cache) => Some(
            tokio::task::spawn_blocking(move || canonical_cache_database(&cache))
                .await
                .map_err(|error| error.to_string())??,
        ),
        None => None,
    };
    let request = serde_json::to_vec(&Pop3AttachmentRequest {
        account_id: account.into(),
        legacy_database,
        folder: folder.into(),
        uid,
        index,
    })
    .map_err(|error| error.to_string())?;
    if request.len() as u64 > MAX_ARCHIVE_ORIGINAL_REQUEST {
        return Err("Mail attachment request is too large".into());
    }
    save_attachment_reply(registry, READ_POP3_ATTACHMENT, request, target)
        .await?
        .ok_or_else(|| "The selected POP3 attachment was not returned".into())
}
