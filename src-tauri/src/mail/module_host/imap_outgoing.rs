//! Send outgoing copies through the authorized IMAP account route.

use std::sync::Arc;

use taomni_mail_api::{
    DISCARD_IMAP_DRAFT, ImapDraftDiscard, ImapDraftStore, ImapSentCopy, MimeUpload,
    RemoteDraftLocation, STORE_IMAP_DRAFT, STORE_IMAP_SENT,
};
use taomni_plugin_stream::routed_tcp::Route;

use super::{PluginRegistry, ResolvedMailAccount, invoke_with_incoming, supports};
#[cfg(any(test, feature = "legacy-mail-imap"))]
use crate::mail::MailImapPool;
use crate::mail::outgoing::PendingSentCopy;

pub(in crate::mail) fn stores_remote_drafts(registry: &PluginRegistry) -> bool {
    supports(registry, STORE_IMAP_DRAFT)
}

pub(in crate::mail) fn discards_remote_drafts(registry: &PluginRegistry) -> bool {
    supports(registry, DISCARD_IMAP_DRAFT)
}

pub(in crate::mail) async fn store_sent_copy(
    registry: Arc<PluginRegistry>,
    #[cfg(any(test, feature = "legacy-mail-imap"))] pool: Arc<MailImapPool>,
    account: ResolvedMailAccount,
    pending: PendingSentCopy,
) -> Result<Option<String>, String> {
    if !supports(&registry, STORE_IMAP_SENT) {
        return legacy_imap!({
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                crate::mail::outgoing::store_pending_copy(&pool, &account, pending, &runtime)
            })
            .await
            .map_err(|error| format!("Mail Sent copy task failed: {error}"))?
        });
    }
    let (_offer, mime) = match pending.copy {
        Some(bytes) => {
            let (offer, upload) = offer_mime(bytes).await?;
            (Some(offer), Some(upload))
        }
        None => (None, None),
    };
    // APPEND is non-idempotent. A lost reply stays a Sent-copy error.
    invoke_with_incoming(registry, &account, STORE_IMAP_SENT, |connection| {
        ImapSentCopy {
            connection,
            account_id: account.config.session_id.clone(),
            folder_override: account.config.special_folders.get("sent").cloned(),
            mime,
            remote_draft: pending.remote_draft,
        }
    })
    .await
}

pub(in crate::mail) async fn store_remote_draft(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    bytes: Vec<u8>,
    message_id: String,
    previous: Option<RemoteDraftLocation>,
) -> Result<Option<RemoteDraftLocation>, String> {
    let (_offer, mime) = offer_mime(bytes).await?;
    let location: Option<RemoteDraftLocation> =
        invoke_with_incoming(registry, account, STORE_IMAP_DRAFT, |connection| {
            ImapDraftStore {
                connection,
                account_id: account.config.session_id.clone(),
                folder_override: account.config.special_folders.get("drafts").cloned(),
                message_id,
                mime,
                previous,
            }
        })
        .await?;
    if location
        .as_ref()
        .is_some_and(|location| location.uid == 0 || location.folder.trim().is_empty())
    {
        return Err("Mail module returned an invalid remote draft location".into());
    }
    Ok(location)
}

pub(in crate::mail) async fn discard_remote_draft(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    location: RemoteDraftLocation,
) -> Result<(), String> {
    invoke_with_incoming(registry, account, DISCARD_IMAP_DRAFT, |connection| {
        ImapDraftDiscard {
            connection,
            location,
        }
    })
    .await
}

async fn offer_mime(bytes: Vec<u8>) -> Result<(Route, MimeUpload), String> {
    let length = bytes.len() as u64;
    let (offer, source) = Route::offer_bytes(bytes)
        .await
        .map_err(|error| format!("Prepare Mail message: {error}"))?;
    Ok((offer, MimeUpload { source, length }))
}
