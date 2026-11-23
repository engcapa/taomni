//! Folder attributes, subscriptions and cheap STATUS change detection (TASK-10).
//!
//! * LIST attributes are stored in RFC 3501/6154 form (`\Noselect`, `\Sent`),
//!   plus `\Subscribed` (RFC 5258) for folders LSUB reports.
//! * Folder SUBSCRIBE/UNSUBSCRIBE; with `sync.subscribedOnly` unsubscribed
//!   folders leave the tree and the sync (INBOX is always kept).
//! * `STATUS (MESSAGES UNSEEN UIDNEXT UIDVALIDITY [HIGHESTMODSEQ])` lets a
//!   periodic scan skip folders the server reports unchanged (one round trip
//!   instead of EXAMINE + SEARCHes).

use taomni_mail_api::FolderSubscription;
use taomni_mail_engine::cache::{refresh_subscription_flags, sync_folder_tree};
use tauri::State;

#[cfg(any(test, feature = "legacy-mail-imap"))]
use super::{ImapSessionOpts, with_imap_session};
use super::{
    MailAccountConfig, MailFolder, ResolvedMailAccount, module_host, resolve_config, with_mail_db,
};
use crate::state::AppState;

#[cfg(test)]
use taomni_mail_engine::imap_folders::imap_list_folders;
#[cfg(any(test, feature = "legacy-mail-imap"))]
pub(super) use taomni_mail_engine::imap_folders::imap_set_subscription;
pub(super) use taomni_mail_engine::imap_folders::{SUBSCRIBED_ATTRIBUTE, folder_visible};

#[cfg(test)]
use taomni_mail_engine::{
    imap_folders::{FolderStatus, imap_folder_status},
    imap_sync::{FolderSyncState, folder_unchanged},
};

pub(super) fn merge_folder_status(previous: &MailFolder, mut status: MailFolder) -> MailFolder {
    status.flags.clone_from(&previous.flags);
    status.delimiter.clone_from(&previous.delimiter);
    status
}

pub(super) fn merge_selected_folder(folders: &mut Vec<MailFolder>, selected: MailFolder) {
    if let Some(existing) = folders.iter_mut().find(|f| f.name == selected.name) {
        *existing = merge_folder_status(existing, selected);
    } else {
        folders.push(selected);
    }
}

/// LIST (+LSUB) the remote folder tree without syncing messages, so a new
/// account shows its folders on open instead of after the first full sync.
#[tauri::command]
pub async fn mail_list_folders(
    config: MailAccountConfig,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    if super::pop3::is_pop3(&config) {
        return super::local_cmds::list_folders(&state, &config.session_id).await;
    }
    let account = resolve_config(&state, config)?;
    let account_id = account.config.session_id.clone();
    let cache_enabled = account.config.cache.enabled;
    let listed = live_imap_folder_tree(&state, account, None, false).await?;
    if !cache_enabled {
        return Ok(listed);
    }
    with_mail_db(&state, &account_id, |db| {
        sync_folder_tree(db, &account_id, &listed)?;
        super::list_cached_folders(db, &account_id)
    })
}

/// Subscribe or unsubscribe a folder; returns the updated cached folders.
#[tauri::command]
pub async fn mail_set_folder_subscription(
    config: MailAccountConfig,
    folder: String,
    subscribed: bool,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    if super::pop3::is_pop3(&config) {
        let _ = (&folder, subscribed);
        return super::local_cmds::list_folders(&state, &config.session_id).await;
    }
    let account = resolve_config(&state, config)?;
    let account_id = account.config.session_id.clone();
    let cache_enabled = account.config.cache.enabled;
    let change = FolderSubscription { folder, subscribed };
    let listed = live_imap_folder_tree(&state, account, Some(change), false).await?;
    if !cache_enabled {
        return Ok(listed);
    }
    with_mail_db(&state, &account_id, |db| {
        refresh_subscription_flags(db, &account_id, &listed)
    })
}

pub(super) async fn live_imap_folder_tree(
    state: &State<'_, AppState>,
    account: ResolvedMailAccount,
    subscription: Option<FolderSubscription>,
    #[cfg_attr(not(any(test, feature = "legacy-mail-imap")), allow(unused_variables))]
    background: bool,
) -> Result<Vec<MailFolder>, String> {
    if module_host::manages_imap_folders(&state.plugins) {
        return module_host::imap_folder_tree(state.plugins.clone(), &account, subscription).await;
    }
    legacy_imap!({
        let pool = std::sync::Arc::clone(&state.legacy.mail.mail_imap_pool);
        let options = if background {
            ImapSessionOpts::background()
        } else {
            ImapSessionOpts::default()
        };
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            with_imap_session(&pool, &account, &handle, options, |imap| {
                if let Some(change) = &subscription {
                    imap.set_subscription(&change.folder, change.subscribed)?;
                }
                imap.list_folders(&account.config.session_id)
            })
        })
        .await
        .map_err(|error| format!("mail folder tree task failed: {error}"))?
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_server_lsub_subscribe_and_status() {
        let fake = super::super::fake_imap::FakeImap::start(true);
        fake.add_folder("Work", 2000);
        fake.add_folder("Old", 2001);
        fake.deliver("INBOX", 3, "status");
        let mut session = fake.session();

        imap_set_subscription(&mut session, "Old", false).unwrap();
        let listed = imap_list_folders(&mut session, "acct").unwrap();
        let old = listed.iter().find(|folder| folder.name == "Old").unwrap();
        assert!(!folder_visible(old, true));
        let work = listed.iter().find(|folder| folder.name == "Work").unwrap();
        assert!(folder_visible(work, true));
        imap_set_subscription(&mut session, "Old", true).unwrap();
        let listed = imap_list_folders(&mut session, "acct").unwrap();
        assert!(listed.iter().all(|folder| folder_visible(folder, true)));

        let status = imap_folder_status(&mut session, "INBOX", true).unwrap();
        assert_eq!(status.messages, Some(3));
        assert_eq!(status.unseen, Some(3));
        assert_eq!(status.uid_next, Some(4));
        assert_eq!(status.uid_validity, Some(1000));
        assert!(status.highest_modseq.is_some());
        // The session stays usable after raw STATUS.
        session.examine("INBOX").unwrap();
    }

    #[test]
    fn unchanged_requires_modseq_watermark_and_count() {
        let state = FolderSyncState {
            uid_validity: Some(7),
            low: Some(1),
            high: Some(39),
            complete: true,
            needs_repair: false,
            highest_modseq: Some(99),
            cached_uids: (1..=12).collect(),
        };
        let status = FolderStatus {
            messages: Some(12),
            unseen: Some(3),
            uid_next: Some(40),
            uid_validity: Some(7),
            highest_modseq: Some(99),
        };
        assert!(folder_unchanged(&state, &status));
        assert!(!folder_unchanged(
            &state,
            &FolderStatus {
                uid_next: Some(41),
                ..status
            }
        ));
        assert!(!folder_unchanged(
            &state,
            &FolderStatus {
                highest_modseq: Some(100),
                ..status
            }
        ));
        assert!(!folder_unchanged(
            &state,
            &FolderStatus {
                highest_modseq: None,
                ..status
            }
        ));
        assert!(!folder_unchanged(
            &state,
            &FolderStatus {
                uid_validity: Some(8),
                ..status
            }
        ));
        assert!(!folder_unchanged(
            &state,
            &FolderStatus {
                messages: Some(11),
                ..status
            }
        ));
        let repairing = FolderSyncState {
            needs_repair: true,
            ..state.clone()
        };
        assert!(!folder_unchanged(&repairing, &status));
        let partial = FolderSyncState {
            complete: false,
            cached_uids: vec![30, 39],
            ..state
        };
        assert!(
            folder_unchanged(&partial, &status),
            "partial cache: modseq decides"
        );
    }
}
