//! Command implementations for POP3 accounts (TASK-21): every mail command
//! checks `pop3::is_pop3` first and runs the local-store variant from here.

use std::collections::HashMap;

use taomni_mail_api::pop3_store::LocalMailboxAction;
use tauri::State;

use super::pop3;
#[cfg(any(test, feature = "legacy-mail-pop3"))]
use super::pop3::Pop3Client;
use super::sync::{MailFolderSyncResult, MailSyncMode};
use super::{
    MailAccountConfig, MailDeleteResult, MailDownloadAttachmentResult, MailFlagResult, MailFolder,
    MailMarkReadResult, MailMessageBody, MailMoveResult, MailSendRequest, MailSendResult,
    MailSyncAllResult, MailTestConnectionResult, MessageBuildOptions, now_ts, pop3_store,
    resolve_config,
};
use crate::state::AppState;

async fn folders(state: &State<'_, AppState>, account_id: &str) -> Result<Vec<MailFolder>, String> {
    pop3_store::prepare_fresh(state, account_id).await?;
    pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::Folders,
        pop3::list_local_folders,
    )
    .await
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
        folder_count: folders(state, &account.config.session_id).await?.len(),
    })
}

/// Download one batch into INBOX; `more` while the server has new mail.
async fn download(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
) -> Result<(Vec<super::MailMessageHeader>, usize, usize), String> {
    let account = resolve_config(state, config)?;
    let account_id = account.config.session_id.clone();
    let _authority = state
        .legacy
        .mail
        .pop3_owner_gate(&account_id)
        .lock_owned()
        .await;
    if pop3_store::prepare_locked(state, &account_id).await? {
        let outcome = super::module_host::pop3_store::sync(state.plugins.clone(), &account).await?;
        let new_unseen = outcome.messages.len();
        return Ok((outcome.messages, new_unseen, outcome.remaining));
    }
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
    let listed = folders(state, &account_id).await?;
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
        folders: folders(state, &account_id).await?,
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

pub(super) async fn list_folders(
    state: &State<'_, AppState>,
    account_id: &str,
) -> Result<Vec<MailFolder>, String> {
    folders(state, account_id).await
}

pub(super) async fn get_body(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> Result<MailMessageBody, String> {
    let folder = folder.to_owned();
    let missing = format!("message {uid} is not in the local {folder} folder");
    pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::Body {
            folder: folder.clone(),
            uid,
        },
        move |db, account| pop3::local_body(db, account, &folder, uid),
    )
    .await?
    .ok_or(missing)
}

pub(super) async fn mark_read(
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
    let key = folder.to_owned();
    let marked = pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::MarkRead {
            folder: key.clone(),
            uids: targets.clone(),
        },
        move |db, account| pop3::mark_local_read(db, account, &key, targets),
    )
    .await?;
    Ok(MailMarkReadResult {
        folder: folder.to_string(),
        marked,
        unread: None,
    })
}

pub(super) async fn set_flags(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> Result<MailFlagResult, String> {
    let (key, ids, added, removed) = (
        folder.to_owned(),
        uids.to_vec(),
        add.to_vec(),
        remove.to_vec(),
    );
    pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::SetFlags {
            folder: key.clone(),
            uids: ids.clone(),
            add: added.clone(),
            remove: removed.clone(),
        },
        move |db, account| pop3::set_local_flags(db, account, &key, &ids, &added, &removed),
    )
    .await?;
    Ok(MailFlagResult {
        folder: folder.to_string(),
        updated: uids.len(),
    })
}

pub(super) async fn move_or_copy(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    target: &str,
    copy: bool,
) -> Result<MailMoveResult, String> {
    let (key, ids, destination) = (folder.to_owned(), uids.to_vec(), target.to_owned());
    let count = pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::MoveOrCopy {
            folder: key.clone(),
            uids: ids.clone(),
            target: destination.clone(),
            copy,
        },
        move |db, account| {
            pop3::ensure_local_folders(db, account)?;
            pop3::move_local(db, account, &key, &ids, &destination, copy)
        },
    )
    .await?;
    Ok(MailMoveResult {
        folder: folder.to_string(),
        target: target.to_string(),
        count,
        mutation: None,
    })
}

pub(super) async fn delete(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uids: Option<Vec<u32>>,
    all: bool,
) -> Result<MailDeleteResult, String> {
    let key = folder.to_owned();
    let targets = if all {
        None
    } else {
        Some(uids.unwrap_or_default())
    };
    let deleted = pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::Delete {
            folder: key.clone(),
            uids: targets.clone(),
        },
        move |db, account| pop3::delete_local(db, account, &key, targets.as_deref()),
    )
    .await?;
    Ok(MailDeleteResult {
        folder: folder.to_string(),
        deleted,
        mutation: None,
    })
}

pub(super) async fn raw(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    let folder = folder.to_owned();
    let missing = format!("message {uid} is not in the local {folder} folder");
    pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::Raw {
            folder: folder.clone(),
            uid,
        },
        move |db, account| pop3::local_raw(db, account, &folder, uid),
    )
    .await?
    .ok_or(missing)
}

pub(super) async fn create_folder(
    state: &State<'_, AppState>,
    account_id: &str,
    name: &str,
) -> Result<Vec<MailFolder>, String> {
    let name = name.to_owned();
    pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::CreateFolder { name: name.clone() },
        move |db, account| {
            pop3::create_local_folder(db, account, &name)?;
            pop3::list_local_folders(db, account)
        },
    )
    .await
}

pub(super) async fn rename_folder(
    state: &State<'_, AppState>,
    account_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<MailFolder>, String> {
    let (from, to) = (from.to_owned(), to.to_owned());
    pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::RenameFolder {
            from: from.clone(),
            to: to.clone(),
        },
        move |db, account| {
            pop3::rename_local_folder(db, account, &from, &to)?;
            pop3::list_local_folders(db, account)
        },
    )
    .await
}

pub(super) async fn delete_folder(
    state: &State<'_, AppState>,
    account_id: &str,
    name: &str,
) -> Result<Vec<MailFolder>, String> {
    if name.eq_ignore_ascii_case("INBOX") {
        return Err("the local INBOX cannot be deleted".into());
    }
    let name = name.to_owned();
    pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::DeleteFolder { name: name.clone() },
        move |db, account| {
            pop3::delete_local_folder(db, account, &name)?;
            pop3::list_local_folders(db, account)
        },
    )
    .await
}

pub(super) async fn download_attachment(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    uid: u32,
    index: usize,
    target_path: &str,
) -> Result<MailDownloadAttachmentResult, String> {
    if target_path.is_empty() {
        return Err("attachment download path is required".into());
    }
    #[cfg(feature = "legacy-mail-pop3")]
    if state.plugins.get(taomni_mail_api::SLUG).is_none() {
        let raw = raw(state, account_id, folder, uid).await?;
        let target_path = target_path.to_owned();
        return super::decode_mail_original(move || {
            let attachment = taomni_mail_engine::extract_attachment(&raw, index)?;
            super::attachment_files::publish_mail_bytes(
                std::path::Path::new(&target_path),
                &attachment.bytes,
            )?;
            Ok(MailDownloadAttachmentResult {
                path: target_path,
                name: attachment.name,
                content_type: attachment.content_type,
                size: attachment.bytes.len(),
            })
        })
        .await;
    }

    let _authority = state
        .legacy
        .mail
        .pop3_owner_gate(account_id)
        .lock_owned()
        .await;
    let cache = if pop3_store::is_hosted(state, account_id).await? {
        None
    } else {
        Some(state.mail_db(account_id)?)
    };
    let receipt = super::module_host::pop3_attachment::save(
        state.plugins.clone(),
        cache,
        account_id,
        folder,
        uid,
        index,
        std::path::Path::new(target_path),
    )
    .await?;
    Ok(MailDownloadAttachmentResult {
        path: target_path.to_owned(),
        name: receipt.name,
        content_type: receipt.content_type,
        size: receipt.size,
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
    pop3_store::prepare_fresh(state, &account_id).await?;
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
                let _authority = state
                    .legacy
                    .mail
                    .pop3_owner_gate(&account_id)
                    .lock_owned()
                    .await;
                let stored: Result<(), String> = match pop3_store::is_hosted(state, &account_id)
                    .await
                {
                    Ok(true) => {
                        let sent_recipients = request
                            .to
                            .into_iter()
                            .chain(request.cc)
                            .chain(request.bcc)
                            .collect();
                        pop3_store::hosted::<usize>(
                            state,
                            &account_id,
                            LocalMailboxAction::Append {
                                folder: "Sent".into(),
                                originals: vec![bytes],
                                sent_recipients,
                            },
                        )
                        .await
                        .map(drop)
                    }
                    Ok(false) => store_legacy_sent_copy(state, account_id, bytes, request).await,
                    Err(error) => Err(error),
                };
                match stored {
                    Ok(()) => result.sent_copy_folder = Some("Sent".into()),
                    Err(e) => result.sent_copy_error = Some(e),
                }
            }
            Err(e) => result.sent_copy_error = Some(e),
        }
    }
    Ok(result)
}

async fn store_legacy_sent_copy(
    state: &AppState,
    account: String,
    bytes: Vec<u8>,
    request: MailSendRequest,
) -> Result<(), String> {
    let cache = state.mail_db(&account)?;
    super::mail_db_task(cache.clone(), account.clone(), move |db, account| {
        pop3::import_local_messages(db, account, "Sent", &[bytes]).map(drop)
    })
    .await?;
    if let Err(error) = super::module_host::record_sent_contacts(
        state.plugins.clone(),
        cache,
        account.clone(),
        request,
    )
    .await
    {
        tracing::warn!(%account, %error, "mail sent; contact cache update failed");
    }
    Ok(())
}

/// Store raw messages (mbox/.eml import) in a local folder.
pub(super) async fn import(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
    messages: Vec<Vec<u8>>,
) -> Result<usize, String> {
    let folder = folder.to_owned();
    let _authority = state
        .legacy
        .mail
        .pop3_owner_gate(account_id)
        .lock_owned()
        .await;
    if pop3_store::is_hosted(state, account_id).await? {
        return pop3_store::hosted(
            state,
            account_id,
            LocalMailboxAction::Append {
                folder,
                originals: messages,
                sent_recipients: Vec::new(),
            },
        )
        .await;
    }
    super::with_mail_db_async(state, account_id, move |db, account| {
        pop3::import_local_messages(db, account, &folder, &messages)
    })
    .await
}

/// Raw messages of a local folder in UID order (mbox export).
pub(super) async fn folder_raw(
    state: &State<'_, AppState>,
    account_id: &str,
    folder: &str,
) -> Result<Vec<(u32, Vec<u8>)>, String> {
    let folder = folder.to_owned();
    pop3_store::run(
        state,
        account_id,
        LocalMailboxAction::Originals {
            folder: folder.clone(),
        },
        move |db, account| pop3::list_local_originals(db, account, &folder),
    )
    .await
}
