//! Outgoing mail on the server (TASK-06): the Sent copy of a sent message and
//! server-side drafts, both stored with IMAP APPEND so other clients see them.
//!
//! A stored copy is found again by its explicit `Message-ID` (`UID SEARCH
//! HEADER Message-ID`), which works without UIDPLUS `APPENDUID` (the `imap`
//! 2.4 crate does not surface response codes of APPEND).

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use taomni_mail_api::RemoteDraftLocation;
use taomni_mail_engine::imap_outgoing::{store_remote_draft, store_sent_copy};
use tauri::State;

pub(super) use taomni_mail_engine::imap_outgoing::imap_append;

use super::{
    ActiveImapSession, ImapSessionOpts, MailAccountConfig, MailDraft, MailImapPool, MailProvider,
    MailSendAttachment, MailSendRequest, MessageBuildOptions, ResolvedMailAccount,
    build_send_message_with, list_mail_drafts, module_host, resolve_config, with_imap_session,
    with_mail_db,
};
use crate::state::AppState;

pub(super) fn save_sent_copy_enabled(config: &MailAccountConfig) -> bool {
    config.save_sent_copy.unwrap_or(!matches!(
        config.provider,
        MailProvider::Gmail | MailProvider::Outlook
    ))
}

/// A fresh `Message-ID` (with brackets) in the sender's domain.
pub(super) fn new_message_id(email_address: &str) -> String {
    let domain = email_address
        .rsplit_once('@')
        .map(|(_, domain)| domain.trim())
        .filter(|domain| !domain.is_empty())
        .unwrap_or("taomni.local");
    format!("<{}@{}>", uuid::Uuid::new_v4().simple(), domain)
}

impl ActiveImapSession {
    pub(super) fn append(
        &mut self,
        folder: &str,
        bytes: &[u8],
        flags: &[&str],
    ) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => imap_append(session, folder, bytes, flags),
            Self::Plain { session, .. } => imap_append(session, folder, bytes, flags),
        }
    }
}

pub(super) fn remote_draft_location(
    conn: &Connection,
    account_id: &str,
    draft_id: &str,
) -> SqlResult<Option<RemoteDraftLocation>> {
    let row: Option<(Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT remote_draft_folder, remote_draft_uid FROM mail_drafts
             WHERE account_id = ?1 AND id = ?2",
            params![account_id, draft_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        Some((Some(folder), Some(uid))) if uid > 0 => Some(RemoteDraftLocation {
            folder,
            uid: uid as u32,
        }),
        _ => None,
    })
}

fn set_remote_draft_location(
    conn: &Connection,
    account_id: &str,
    draft_id: &str,
    location: Option<&RemoteDraftLocation>,
) -> SqlResult<()> {
    conn.execute(
        "UPDATE mail_drafts SET remote_draft_folder = ?3, remote_draft_uid = ?4
         WHERE account_id = ?1 AND id = ?2",
        params![
            account_id,
            draft_id,
            location.map(|l| l.folder.clone()),
            location.map(|l| l.uid as i64),
        ],
    )?;
    Ok(())
}

pub(super) struct PendingSentCopy {
    pub(super) copy: Option<Vec<u8>>,
    pub(super) remote_draft: Option<RemoteDraftLocation>,
}

/// Prepare local MIME before SMTP; once SMTP accepts, only the independent
/// copy task may fail. Such a failure must never cause the caller to resend.
pub(super) fn prepare_send(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
    remote_draft: Option<RemoteDraftLocation>,
) -> Result<(lettre::Message, Option<PendingSentCopy>), String> {
    let message_id = new_message_id(&account.config.email_address);
    let save_copy = save_sent_copy_enabled(&account.config);
    let copy = if save_copy {
        Some(
            build_send_message_with(
                account,
                request,
                &MessageBuildOptions {
                    message_id: Some(message_id.clone()),
                    keep_bcc: true,
                    self_envelope: false,
                },
            )?
            .formatted(),
        )
    } else {
        None
    };
    let message = build_send_message_with(
        account,
        request,
        &MessageBuildOptions {
            message_id: Some(message_id),
            ..MessageBuildOptions::default()
        },
    )?;
    let pending = (copy.is_some() || remote_draft.is_some())
        .then_some(PendingSentCopy { copy, remote_draft });
    Ok((message, pending))
}

pub(super) fn store_pending_copy(
    pool: &MailImapPool,
    account: &ResolvedMailAccount,
    pending: PendingSentCopy,
    runtime: &tokio::runtime::Handle,
) -> Result<Option<String>, String> {
    // APPEND is not idempotent: a lost response must not duplicate the copy.
    let opts = ImapSessionOpts {
        retry_on_error: false,
        ..ImapSessionOpts::default()
    };
    let folder_override = account
        .config
        .special_folders
        .get("sent")
        .map(String::as_str);
    with_imap_session(pool, account, runtime, opts, |imap| match imap {
        ActiveImapSession::Plain { session, .. } => store_sent_copy(
            session,
            &account.config.session_id,
            folder_override,
            pending.copy.as_deref(),
            pending.remote_draft.as_ref(),
        ),
        ActiveImapSession::Tls { session, .. } => store_sent_copy(
            session,
            &account.config.session_id,
            folder_override,
            pending.copy.as_deref(),
            pending.remote_draft.as_ref(),
        ),
    })
}

fn draft_send_request(draft: &MailDraft) -> MailSendRequest {
    MailSendRequest {
        to: draft.to.clone(),
        cc: draft.cc.clone(),
        bcc: draft.bcc.clone(),
        subject: draft.subject.clone(),
        text_body: Some(draft.text_body.clone()).filter(|text| !text.trim().is_empty()),
        html_body: Some(draft.html_body.clone()).filter(|html| !html.trim().is_empty()),
        attachments: draft
            .attachments
            .iter()
            .map(|attachment| MailSendAttachment {
                path: attachment.path.clone(),
                name: attachment.name.clone(),
                content_type: attachment.content_type.clone(),
                inline: attachment.inline,
                content_id: attachment.content_id.clone(),
            })
            .collect(),
        in_reply_to: draft
            .reply_context
            .as_ref()
            .filter(|context| context.kind.as_deref() != Some("forward"))
            .and_then(|context| context.message_id.clone()),
        references: draft
            .reply_context
            .as_ref()
            .filter(|context| context.kind.as_deref() != Some("forward"))
            .map(|context| context.references.clone())
            .unwrap_or_default(),
        draft_id: Some(draft.id.clone()),
        from: None,
        reply_to: None,
        request_read_receipt: false,
    }
}

/// Store (or replace) the server copy of a local draft in the Drafts folder,
/// so other clients see it. Returns the draft with its new server location.
#[tauri::command]
pub async fn mail_store_remote_draft(
    config: MailAccountConfig,
    draft_id: String,
    state: State<'_, AppState>,
) -> Result<MailDraft, String> {
    if super::pop3::is_pop3(&config) {
        // POP3 has no server Drafts folder; the local draft is the only copy.
        return with_mail_db(&state, &config.session_id, |db| {
            Ok(list_mail_drafts(db, &config.session_id)?
                .into_iter()
                .find(|draft| draft.id == draft_id))
        })?
        .ok_or_else(|| format!("draft {draft_id} not found"));
    }
    let account = resolve_config(&state, config)?;
    let account_id = account.config.session_id.clone();
    let draft = with_mail_db(&state, &account_id, |db| {
        Ok(list_mail_drafts(db, &account_id)?
            .into_iter()
            .find(|draft| draft.id == draft_id))
    })?
    .ok_or_else(|| format!("draft {draft_id} not found"))?;
    let previous = with_mail_db(&state, &account_id, |db| {
        remote_draft_location(db, &account_id, &draft.id)
    })?;
    let message_id = new_message_id(&account.config.email_address);
    let bytes = build_send_message_with(
        &account,
        &draft_send_request(&draft),
        &MessageBuildOptions {
            message_id: Some(message_id.clone()),
            keep_bcc: true,
            self_envelope: true,
        },
    )?
    .formatted();
    let location = if module_host::stores_remote_drafts(&state.plugins) {
        module_host::store_remote_draft(
            state.plugins.clone(),
            &account,
            bytes,
            message_id,
            previous,
        )
        .await?
    } else {
        let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let folder = account
                .config
                .special_folders
                .get("drafts")
                .map(String::as_str);
            // A server can accept APPEND before its response reaches us.
            let opts = ImapSessionOpts {
                retry_on_error: false,
                ..ImapSessionOpts::default()
            };
            with_imap_session(&pool, &account, &handle, opts, |imap| match imap {
                ActiveImapSession::Plain { session, .. } => store_remote_draft(
                    session,
                    &account.config.session_id,
                    folder,
                    &bytes,
                    &message_id,
                    previous.as_ref(),
                ),
                ActiveImapSession::Tls { session, .. } => store_remote_draft(
                    session,
                    &account.config.session_id,
                    folder,
                    &bytes,
                    &message_id,
                    previous.as_ref(),
                ),
            })
        })
        .await
        .map_err(|error| format!("Mail draft task failed: {error}"))??
    };
    with_mail_db(&state, &account_id, |db| {
        set_remote_draft_location(db, &account_id, &draft.id, location.as_ref())?;
        Ok(list_mail_drafts(db, &account_id)?
            .into_iter()
            .find(|candidate| candidate.id == draft.id))
    })?
    .ok_or_else(|| "draft disappeared while storing it".to_string())
}

/// Delete the server copy of a draft (local row is kept; `mail_delete_draft`
/// removes it).
#[tauri::command]
pub async fn mail_discard_remote_draft(
    config: MailAccountConfig,
    draft_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if super::pop3::is_pop3(&config) {
        let _ = (&draft_id, &state);
        return Ok(false);
    }
    let account = resolve_config(&state, config)?;
    let account_id = account.config.session_id.clone();
    let Some(location) = with_mail_db(&state, &account_id, |db| {
        remote_draft_location(db, &account_id, &draft_id)
    })?
    else {
        return Ok(false);
    };
    if module_host::discards_remote_drafts(&state.plugins) {
        module_host::discard_remote_draft(state.plugins.clone(), &account, location).await?;
    } else {
        let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            with_imap_session(
                &pool,
                &account,
                &handle,
                ImapSessionOpts::default(),
                |imap| imap.delete_messages(&location.folder, &[location.uid], false),
            )
        })
        .await
        .map_err(|error| format!("Mail draft task failed: {error}"))??;
    }
    with_mail_db(&state, &account_id, |db| {
        set_remote_draft_location(db, &account_id, &draft_id, None)
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::super::fake_imap::FakeImap;
    use super::*;
    use taomni_mail_engine::imap_outgoing::uid_by_message_id;

    #[test]
    fn sent_copy_defaults_follow_provider() {
        let mut config: MailAccountConfig = serde_json::from_value(serde_json::json!({
            "sessionId": "acct",
            "emailAddress": "user@example.com",
            "imap": { "host": "h", "port": 1, "security": "None" },
            "smtp": { "host": "h", "port": 1, "security": "None" },
        }))
        .unwrap();
        assert!(save_sent_copy_enabled(&config));
        config.provider = MailProvider::Gmail;
        assert!(!save_sent_copy_enabled(&config));
        config.save_sent_copy = Some(true);
        assert!(save_sent_copy_enabled(&config));
    }

    #[test]
    fn message_ids_are_unique_and_use_sender_domain() {
        let a = new_message_id("me@example.org");
        let b = new_message_id("me@example.org");
        assert_ne!(a, b);
        assert!(a.starts_with('<') && a.ends_with("@example.org>"));
        assert!(new_message_id("broken").ends_with("@taomni.local>"));
    }

    #[test]
    fn append_then_find_by_message_id_on_fake_server() {
        let fake = FakeImap::start(false);
        fake.add_folder("Drafts", 3000);
        let mut session = fake.session();
        let id = new_message_id("me@example.com");
        let raw = format!("Message-ID: {id}\r\nSubject: draft\r\n\r\nbody\r\n");
        imap_append(
            &mut session,
            "Drafts",
            raw.as_bytes(),
            &["\\Draft", "\\Seen"],
        )
        .unwrap();
        let uid = uid_by_message_id(&mut session, "Drafts", &id).unwrap();
        assert_eq!(uid, Some(1));
        assert_eq!(fake.flags("Drafts", 1), vec!["\\Draft", "\\Seen"]);
        assert_eq!(
            uid_by_message_id(&mut session, "Drafts", "<missing@example.com>").unwrap(),
            None
        );
    }
}
