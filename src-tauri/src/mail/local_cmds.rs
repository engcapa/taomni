//! Command implementations for POP3 accounts (TASK-21): every mail command
//! checks `pop3::is_pop3` first and runs the local-store variant from here.

use std::collections::HashMap;

use tauri::State;

use super::pop3;
#[cfg(any(test, feature = "legacy-mail-pop3"))]
use super::pop3::Pop3Client;
use super::sync::{MailFolderSyncResult, MailSyncMode};
use super::{
    MailAccountConfig, MailDeleteResult, MailDownloadAttachmentResult, MailFlagResult, MailFolder,
    MailMarkReadResult, MailMessageBody, MailMoveResult, MailSendRequest, MailSendResult,
    MailSyncAllResult, MailTestConnectionResult, MessageBuildOptions, extract_attachment, now_ts,
    resolve_config, upsert_sent_contacts, with_mail_db,
};
use crate::state::AppState;

fn folders(state: &State<'_, AppState>, account_id: &str) -> Result<Vec<MailFolder>, String> {
    with_mail_db(state, account_id, |db| {
        pop3::list_local_folders(db, account_id)
    })
}

fn folder_meta(folders: &[MailFolder], name: &str, account_id: &str) -> MailFolder {
    folders
        .iter()
        .find(|folder| folder.name == name)
        .cloned()
        .unwrap_or_else(|| MailFolder {
            account_id: account_id.to_string(),
            name: name.to_string(),
            display_name: name.to_string(),
            sync_complete: true,
            ..MailFolder::default()
        })
}

pub(super) async fn test_connection(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
) -> Result<MailTestConnectionResult, String> {
    let account = resolve_config(state, config)?;
    if super::module_host::checks_incoming(&state.plugins) {
        super::module_host::check_incoming(state.plugins.clone(), &account).await?;
    } else {
        #[cfg(not(any(test, feature = "legacy-mail-pop3")))]
        return Err(super::SIGNED_MAIL_CONNECTION_REQUIRED.into());
        #[cfg(any(test, feature = "legacy-mail-pop3"))]
        {
            let incoming = account.clone();
            let handle = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || Pop3Client::connect(&incoming, &handle)?.quit())
                .await
                .map_err(|error| format!("POP3 test task failed: {error}"))??;
        }
    }
    let smtp_ok = super::module_host::test_smtp(state.plugins.clone(), &account)
        .await
        .is_ok();
    Ok(MailTestConnectionResult {
        imap_ok: true,
        smtp_ok,
        folder_count: folders(state, &account.config.session_id)?.len(),
    })
}

/// Download one batch into INBOX; `more` while the server has new mail.
async fn download(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
) -> Result<(Vec<super::MailMessageHeader>, usize, usize), String> {
    let account = resolve_config(state, config)?;
    let account_id = account.config.session_id.clone();
    let leave_days = account.config.pop3_leave_days;
    let db = state.mail_db(&account_id)?;
    let gate = state.legacy.mail.mutation_gate(&account_id);
    let registry = state.plugins.clone();
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let _local = gate.lock().map_err(|error| error.to_string())?;
        let ledger = pop3::sqlite_ledger(|| db.lock(), &account_id);
        let sync = |mailbox: &mut dyn taomni_mail_engine::pop3::Pop3Mailbox| {
            pop3::sync_inbox(mailbox, &ledger, leave_days)
        };
        let outcome = if super::module_host::runs_pop3_rounds(&registry) {
            let _mutation = db.mutation_lease()?;
            super::module_host::run_pop3_round(registry, &account, handle, &ledger)?
        } else if super::module_host::syncs_pop3(&registry) {
            let _mutation = db.mutation_lease()?;
            let mut client = super::module_host::HostedPop3::open(registry, &account, handle)?;
            sync(&mut client)?
        } else {
            #[cfg(not(any(test, feature = "legacy-mail-pop3")))]
            return Err(super::SIGNED_MAIL_CONNECTION_REQUIRED.into());
            #[cfg(any(test, feature = "legacy-mail-pop3"))]
            {
                let _mutation = db.mutation_lease()?;
                let mut client = Pop3Client::connect(&account, &handle)?;
                sync(&mut client.session)?
            }
        };
        let new_unseen = outcome.messages.len();
        Ok((outcome.messages, new_unseen, outcome.remaining))
    })
    .await
    .map_err(|e| format!("POP3 sync task failed: {e}"))?
}

pub(super) async fn sync_folder(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
    folder: &str,
) -> Result<MailFolderSyncResult, String> {
    let account_id = config.session_id.clone();
    let (messages, new_unseen, remaining) = if folder.eq_ignore_ascii_case("INBOX") {
        download(state, config).await?
    } else {
        (Vec::new(), 0, 0)
    };
    let listed = folders(state, &account_id)?;
    Ok(MailFolderSyncResult {
        account_id: account_id.clone(),
        folder: folder_meta(&listed, folder, &account_id),
        mode: MailSyncMode::Catchup,
        fetched: messages.len(),
        messages,
        new_unseen,
        vanished: 0,
        flags_updated: 0,
        remaining_new: remaining,
        more: remaining > 0,
        sync_complete: true,
        uid_validity_reset: false,
        synced_at: now_ts(),
    })
}

pub(super) async fn sync_all(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
) -> Result<MailSyncAllResult, String> {
    let account_id = config.session_id.clone();
    let (messages, new_unseen, remaining) = download(state, config).await?;
    let mut new_unseen_by_folder = HashMap::new();
    if new_unseen > 0 {
        new_unseen_by_folder.insert("INBOX".to_string(), new_unseen);
    }
    Ok(MailSyncAllResult {
        account_id: account_id.clone(),
        folders: folders(state, &account_id)?,
        fetched_messages: messages.len(),
        new_messages: new_unseen,
        new_unseen_by_folder,
        failed_folders: Vec::new(),
        pending_folders: if remaining > 0 {
            vec!["INBOX".into()]
        } else {
            Vec::new()
        },
        unchanged_folders: Vec::new(),
        cached_bodies: messages.len(),
        synced_at: now_ts(),
    })
}

pub(super) fn list_folders(
    state: &State<'_, AppState>,
    account_id: &str,
) -> Result<Vec<MailFolder>, String> {
    folders(state, account_id)
}

pub(super) fn get_body(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> Result<MailMessageBody, String> {
    with_mail_db(state, account_id, |db| {
        pop3::local_body(db, account_id, folder, uid)
    })?
    .ok_or_else(|| format!("message {uid} is not in the local {folder} folder"))
}

pub(super) fn mark_read(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uids: Option<Vec<u32>>,
    all: bool,
) -> Result<MailMarkReadResult, String> {
    let targets = if all {
        None
    } else {
        Some(uids.unwrap_or_default())
    };
    let marked = with_mail_db(state, account_id, |db| {
        pop3::mark_local_read(db, account_id, folder, targets)
    })?;
    Ok(MailMarkReadResult {
        folder: folder.to_string(),
        marked,
        unread: None,
    })
}

pub(super) fn set_flags(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> Result<MailFlagResult, String> {
    with_mail_db(state, account_id, |db| {
        pop3::set_local_flags(db, account_id, folder, uids, add, remove)
    })?;
    Ok(MailFlagResult {
        folder: folder.to_string(),
        updated: uids.len(),
    })
}

pub(super) fn move_or_copy(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    target: &str,
    copy: bool,
) -> Result<MailMoveResult, String> {
    let count = with_mail_db(state, account_id, |db| {
        pop3::ensure_local_folders(db, account_id)?;
        pop3::move_local(db, account_id, folder, uids, target, copy)
    })?;
    Ok(MailMoveResult {
        folder: folder.to_string(),
        target: target.to_string(),
        count,
        mutation: None,
    })
}

pub(super) fn delete(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uids: Option<Vec<u32>>,
    all: bool,
) -> Result<MailDeleteResult, String> {
    let deleted = with_mail_db(state, account_id, |db| {
        let targets = if all {
            None
        } else {
            Some(uids.clone().unwrap_or_default())
        };
        pop3::delete_local(db, account_id, folder, targets.as_deref())
    })?;
    Ok(MailDeleteResult {
        folder: folder.to_string(),
        deleted,
        mutation: None,
    })
}

pub(super) fn raw(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    with_mail_db(state, account_id, |db| {
        pop3::local_raw(db, account_id, folder, uid)
    })?
    .ok_or_else(|| format!("message {uid} is not in the local {folder} folder"))
}

pub(super) fn create_folder(
    state: &State<'_, AppState>,
    account_id: &str,
    name: &str,
) -> Result<Vec<MailFolder>, String> {
    with_mail_db(state, account_id, |db| {
        pop3::create_local_folder(db, account_id, name)
    })?;
    folders(state, account_id)
}

pub(super) fn rename_folder(
    state: &State<'_, AppState>,
    account_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<MailFolder>, String> {
    with_mail_db(state, account_id, |db| {
        pop3::rename_local_folder(db, account_id, from, to)
    })?;
    folders(state, account_id)
}

pub(super) fn delete_folder(
    state: &State<'_, AppState>,
    account_id: &str,
    name: &str,
) -> Result<Vec<MailFolder>, String> {
    if name.eq_ignore_ascii_case("INBOX") {
        return Err("the local INBOX cannot be deleted".into());
    }
    with_mail_db(state, account_id, |db| {
        pop3::delete_local_folder(db, account_id, name)
    })?;
    folders(state, account_id)
}

pub(super) fn download_attachment(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uid: u32,
    index: usize,
    target_path: &str,
) -> Result<MailDownloadAttachmentResult, String> {
    let raw = raw(state, account_id, folder, uid)?;
    let attachment = extract_attachment(&raw, index)?;
    let path = super::write_attachment_file(target_path, &attachment.bytes)?;
    Ok(MailDownloadAttachmentResult {
        path,
        name: attachment.name,
        content_type: attachment.content_type,
        size: attachment.bytes.len(),
    })
}

/// SMTP send; the Sent copy goes to the local Sent folder.
pub(super) async fn send(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
    request: MailSendRequest,
) -> Result<MailSendResult, String> {
    let account = resolve_config(state, config)?;
    let account_id = account.config.session_id.clone();
    let message_id = super::outgoing::new_message_id(&account.config.email_address);
    let message = super::module_host::compose_message(
        state.plugins.clone(),
        &account,
        request.clone(),
        MessageBuildOptions {
            message_id: Some(message_id.clone()),
            ..MessageBuildOptions::default()
        },
    )
    .await?;
    let copy = super::module_host::compose_message(
        state.plugins.clone(),
        &account,
        request.clone(),
        MessageBuildOptions {
            message_id: Some(message_id),
            keep_bcc: true,
            self_envelope: false,
        },
    )
    .await
    .map(|message| message.bytes);
    let response = super::module_host::send_smtp(state.plugins.clone(), &account, message).await?;
    let mut result = MailSendResult {
        accepted: true,
        response,
        sent_copy_folder: None,
        sent_copy_error: None,
    };
    if result.accepted {
        match copy {
            Ok(bytes) => {
                let stored = with_mail_db(state, &account_id, |db| {
                    pop3::import_local_messages(db, &account_id, "Sent", &[bytes])?;
                    upsert_sent_contacts(db, &account_id, &request)
                });
                match stored {
                    Ok(_) => result.sent_copy_folder = Some("Sent".into()),
                    Err(e) => result.sent_copy_error = Some(e),
                }
            }
            Err(e) => result.sent_copy_error = Some(e),
        }
    }
    Ok(result)
}

/// Store raw messages (mbox/.eml import) in a local folder.
pub(super) fn import(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    messages: &[Vec<u8>],
) -> Result<usize, String> {
    with_mail_db(state, account_id, |db| {
        pop3::import_local_messages(db, account_id, folder, messages)
    })
}

/// Raw messages of a local folder in UID order (mbox export).
pub(super) fn folder_raw(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
) -> Result<Vec<(u32, Vec<u8>)>, String> {
    with_mail_db(state, account_id, |db| {
        pop3::list_local_originals(db, account_id, folder)
    })
}
