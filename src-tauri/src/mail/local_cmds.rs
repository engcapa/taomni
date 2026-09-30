//! Command implementations for POP3 accounts (TASK-21): every mail command
//! checks `pop3::is_pop3` first and runs the local-store variant from here.

use std::collections::HashMap;

use tauri::State;

use super::pop3::{self, Pop3Client};
use super::sync::{MailFolderSyncResult, MailSyncMode};
use super::{
    MailAccountConfig, MailDeleteResult, MailDownloadAttachmentResult, MailFlagResult, MailFolder,
    MailMarkReadResult, MailMessageBody, MailMoveResult, MailSendRequest, MailSendResult,
    MailSyncAllResult, MailTestConnectionResult, MessageBuildOptions, build_send_message_with,
    cached_to_body, extract_attachment, get_cached_body, list_cached_folders,
    mark_cached_messages_read, now_ts, resolve_config, send_smtp_with, test_smtp,
    unread_cached_uids, update_cached_flags, upsert_sent_contacts, with_mail_db,
};
use crate::state::AppState;

fn folders(state: &State<'_, AppState>, account_id: &str) -> Result<Vec<MailFolder>, String> {
    with_mail_db(state, account_id, |db| {
        pop3::ensure_local_folders(db, account_id)?;
        list_cached_folders(db, account_id)
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
    let handle = tokio::runtime::Handle::current();
    let account_id = account.config.session_id.clone();
    let smtp_ok = tokio::task::spawn_blocking(move || {
        let client = Pop3Client::connect(&account, &handle)?;
        client.quit()?;
        Ok::<bool, String>(test_smtp(&account, &handle).is_ok())
    })
    .await
    .map_err(|e| format!("POP3 test task failed: {e}"))??;
    Ok(MailTestConnectionResult {
        imap_ok: true,
        smtp_ok,
        folder_count: folders(state, &account_id)?.len(),
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
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let mut client = Pop3Client::connect(&account, &handle)?;
        let outcome = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            super::init_mail_tables(&conn).map_err(|e| e.to_string())?;
            pop3::sync_inbox(&mut client, &conn, &account_id, leave_days)?
        };
        client.quit()?;
        let new_unseen = outcome.messages.len();
        let headers = outcome.messages.into_iter().map(|m| m.header).collect();
        Ok((headers, new_unseen, outcome.remaining))
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
        if let Some(body) = get_cached_body(db, account_id, folder, uid)? {
            return Ok(Some(body));
        }
        Ok(pop3::local_raw(db, account_id, folder, uid)?.map(|raw| {
            let message = super::parse_body_message(
                account_id,
                folder,
                uid,
                Some(raw.len() as u32),
                &raw,
                8 * 1024 * 1024,
            );
            cached_to_body(message, "cache")
        }))
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
    let marked = with_mail_db(state, account_id, |db| {
        let targets = if all {
            unread_cached_uids(db, account_id, folder)?
        } else {
            uids.clone().unwrap_or_default()
        };
        mark_cached_messages_read(db, account_id, folder, &targets)?;
        pop3::refresh_counts(db, account_id, folder)?;
        Ok(targets.len())
    })?;
    Ok(MailMarkReadResult {
        folder: folder.to_string(),
        marked,
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
        update_cached_flags(db, account_id, folder, uids, add, remove)?;
        pop3::refresh_counts(db, account_id, folder)
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
    let handle = tokio::runtime::Handle::current();
    let request_for_task = request.clone();
    let (mut result, copy) = tokio::task::spawn_blocking(move || {
        let message_id = super::outgoing::new_message_id(&account.config.email_address);
        let result = send_smtp_with(
            &account,
            &request_for_task,
            &handle,
            &MessageBuildOptions {
                message_id: Some(message_id.clone()),
                ..MessageBuildOptions::default()
            },
        )?;
        let copy = build_send_message_with(
            &account,
            &request_for_task,
            &MessageBuildOptions {
                message_id: Some(message_id),
                keep_bcc: true,
                self_envelope: false,
            },
        )
        .map(|message| message.formatted());
        Ok::<_, String>((result, copy))
    })
    .await
    .map_err(|e| format!("mail send task failed: {e}"))??;
    if result.accepted {
        match copy {
            Ok(bytes) => {
                let stored = with_mail_db(state, &account_id, |db| {
                    pop3::ensure_local_folders(db, &account_id)?;
                    pop3::insert_local(db, &account_id, "Sent", &bytes, &["\\Seen"])?;
                    pop3::refresh_counts(db, &account_id, "Sent")?;
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
        pop3::ensure_local_folders(db, account_id)?;
        for message in messages {
            pop3::insert_local(db, account_id, folder, message, &["\\Seen"])?;
        }
        pop3::refresh_counts(db, account_id, folder)?;
        Ok(messages.len())
    })
}

/// Raw messages of a local folder in UID order (mbox export).
pub(super) fn folder_raw(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
) -> Result<Vec<(u32, Vec<u8>)>, String> {
    with_mail_db(state, account_id, |db| {
        pop3::migrate_local_tables(db)?;
        let mut stmt = db.prepare(
            "SELECT uid, raw FROM mail_local_raw WHERE account_id = ?1 AND folder = ?2 ORDER BY uid",
        )?;
        let rows = stmt.query_map(rusqlite::params![account_id, folder], |row| {
            Ok((row.get::<_, i64>(0)? as u32, row.get::<_, Vec<u8>>(1)?))
        })?;
        rows.collect()
    })
}
