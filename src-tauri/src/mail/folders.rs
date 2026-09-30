//! Folder attributes, subscriptions and cheap STATUS change detection (TASK-10).
//!
//! * LIST attributes are stored in RFC 3501/6154 form (`\Noselect`, `\Sent`),
//!   plus `\Subscribed` (RFC 5258) for folders LSUB reports.
//! * Folder SUBSCRIBE/UNSUBSCRIBE; with `sync.subscribedOnly` unsubscribed
//!   folders leave the tree and the sync (INBOX is always kept).
//! * `STATUS (MESSAGES UNSEEN UIDNEXT UIDVALIDITY [HIGHESTMODSEQ])` lets a
//!   periodic scan skip folders the server reports unchanged (one round trip
//!   instead of EXAMINE + SEARCHes).

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};

use imap::types::NameAttribute;
use tauri::State;

use super::sync::{FolderSyncState, quote_imap_string};
use super::{MailAccountConfig, MailFolder, resolve_config, with_imap_session, with_mail_db};
use crate::state::AppState;

pub(super) const SUBSCRIBED_ATTRIBUTE: &str = "\\Subscribed";

/// RFC wire form of a LIST attribute (the `imap` crate only has Debug output).
pub(super) fn attribute_string(attribute: &NameAttribute<'_>) -> String {
    match attribute {
        NameAttribute::NoInferiors => "\\Noinferiors".into(),
        NameAttribute::NoSelect => "\\Noselect".into(),
        NameAttribute::Marked => "\\Marked".into(),
        NameAttribute::Unmarked => "\\Unmarked".into(),
        NameAttribute::Custom(value) => value.to_string(),
    }
}

pub(super) fn folder_is_inbox(folder: &MailFolder) -> bool {
    folder.name.eq_ignore_ascii_case("INBOX")
}

pub(super) fn folder_is_subscribed(folder: &MailFolder) -> bool {
    folder
        .flags
        .iter()
        .any(|flag| flag.eq_ignore_ascii_case(SUBSCRIBED_ATTRIBUTE))
}

/// Whether the tree/sync should include `folder` under `subscribed_only`.
pub(super) fn folder_visible(folder: &MailFolder, subscribed_only: bool) -> bool {
    !subscribed_only || folder_is_inbox(folder) || folder_is_subscribed(folder)
}

/// Mark LSUB-reported folders `\Subscribed`. An empty or failed LSUB means
/// the server does not track subscriptions: every folder counts as subscribed
/// so "subscribed only" never hides a whole account.
pub(super) fn mark_subscribed(folders: &mut [MailFolder], subscribed: Option<HashSet<String>>) {
    let subscribed = subscribed.filter(|names| !names.is_empty());
    for folder in folders.iter_mut() {
        folder
            .flags
            .retain(|flag| !flag.eq_ignore_ascii_case(SUBSCRIBED_ATTRIBUTE));
        let on = subscribed
            .as_ref()
            .is_none_or(|names| names.contains(&folder.name));
        if on {
            folder.flags.push(SUBSCRIBED_ATTRIBUTE.into());
        }
    }
}

pub(super) fn imap_subscribed_names<T: Read + Write>(
    session: &mut imap::Session<T>,
) -> Option<HashSet<String>> {
    session
        .lsub(Some(""), Some("*"))
        .ok()
        .map(|names| names.iter().map(|name| name.name().to_string()).collect())
}

pub(super) fn imap_set_subscription<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    subscribed: bool,
) -> Result<(), String> {
    let result = if subscribed {
        session.subscribe(folder)
    } else {
        session.unsubscribe(folder)
    };
    result.map_err(|e| {
        let verb = if subscribed {
            "SUBSCRIBE"
        } else {
            "UNSUBSCRIBE"
        };
        format!("IMAP {verb} {folder} failed: {e}")
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct FolderStatus {
    pub messages: Option<u32>,
    pub unseen: Option<u32>,
    pub uid_next: Option<u32>,
    pub uid_validity: Option<u32>,
    pub highest_modseq: Option<u64>,
}

/// Parse `* STATUS <name> (KEY value ...)` from a raw response.
pub(super) fn parse_status_response(raw: &str) -> Option<FolderStatus> {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|line| line.to_ascii_uppercase().starts_with("* STATUS "))?;
    let open = line.rfind('(')?;
    let close = line.rfind(')')?;
    if close <= open {
        return None;
    }
    let mut status = FolderStatus::default();
    let mut parts = line[open + 1..close].split_whitespace();
    while let (Some(key), Some(value)) = (parts.next(), parts.next()) {
        match key.to_ascii_uppercase().as_str() {
            "MESSAGES" => status.messages = value.parse().ok(),
            "UNSEEN" => status.unseen = value.parse().ok(),
            "UIDNEXT" => status.uid_next = value.parse().ok(),
            "UIDVALIDITY" => status.uid_validity = value.parse().ok(),
            "HIGHESTMODSEQ" => status.highest_modseq = value.parse().ok(),
            _ => {}
        }
    }
    Some(status)
}

/// Raw STATUS: the crate's typed `status()` routes the attributes through the
/// unsolicited channel, which desynced some Outlook + proxy streams.
pub(super) fn imap_folder_status<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    condstore: bool,
) -> Option<FolderStatus> {
    let items = if condstore {
        "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ)"
    } else {
        "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)"
    };
    let raw = session
        .run_command_and_read_response(format!("STATUS {} {items}", quote_imap_string(folder)))
        .ok()?;
    parse_status_response(&String::from_utf8_lossy(&raw))
}

/// True when STATUS proves nothing changed since the last sync: same
/// UIDVALIDITY, no UID above the watermark and, because only CONDSTORE can
/// reveal flag changes and expunges without a fetch, the same HIGHESTMODSEQ
/// (plus the same message count when the cache holds the whole folder).
pub(super) fn folder_unchanged(state: &FolderSyncState, status: &FolderStatus) -> bool {
    if state.needs_repair {
        return false;
    }
    let (Some(high), Some(uid_next)) = (state.high, status.uid_next) else {
        return false;
    };
    if state.uid_validity.is_none() || state.uid_validity != status.uid_validity {
        return false;
    }
    if uid_next.saturating_sub(1) > high {
        return false;
    }
    match (state.highest_modseq, status.highest_modseq) {
        (Some(cached), Some(remote)) if cached == remote => {}
        _ => return false,
    }
    if state.complete && status.messages != Some(state.cached_uids.len() as u32) {
        return false;
    }
    true
}

/// Special-folder override from the account settings (`sent`, `drafts`, ...).
pub(super) fn special_folder_override(
    config: &MailAccountConfig,
    folders: &[MailFolder],
    key: &str,
) -> Option<String> {
    let wanted = config.special_folders.get(key)?.trim();
    if wanted.is_empty() {
        return None;
    }
    folders
        .iter()
        .find(|folder| folder.name == wanted || folder.display_name == wanted)
        .map(|folder| folder.name.clone())
}

/// Subscribe or unsubscribe a folder; returns the updated cached folders.
#[tauri::command]
pub async fn mail_set_folder_subscription(
    config: MailAccountConfig,
    folder: String,
    subscribed: bool,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    let account = resolve_config(&state, config)?;
    let account_id = account.config.session_id.clone();
    let cache_enabled = account.config.cache.enabled;
    let pool = std::sync::Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let listed = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            super::ImapSessionOpts::default(),
            |imap| {
                imap.set_subscription(&folder, subscribed)?;
                imap.list_folders(&account.config.session_id)
            },
        )
    })
    .await
    .map_err(|e| format!("mail subscription task failed: {e}"))??;
    if !cache_enabled {
        return Ok(listed);
    }
    with_mail_db(&state, &account_id, |db| {
        let flags: HashMap<&str, &MailFolder> = listed
            .iter()
            .map(|folder| (folder.name.as_str(), folder))
            .collect();
        let mut cached = super::list_cached_folders(db, &account_id)?;
        for folder in cached.iter_mut() {
            if let Some(remote) = flags.get(folder.name.as_str()) {
                folder.flags = remote.flags.clone();
                super::upsert_folder(db, folder)?;
            }
        }
        super::list_cached_folders(db, &account_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str, flags: &[&str]) -> MailFolder {
        MailFolder {
            account_id: "acct".into(),
            name: name.into(),
            display_name: name.into(),
            flags: flags.iter().map(|flag| flag.to_string()).collect(),
            ..MailFolder::default()
        }
    }

    #[test]
    fn attributes_use_rfc_form() {
        assert_eq!(attribute_string(&NameAttribute::NoSelect), "\\Noselect");
        assert_eq!(
            attribute_string(&NameAttribute::Custom("\\Sent".into())),
            "\\Sent"
        );
    }

    #[test]
    fn subscriptions_mark_folders_and_empty_lsub_means_all() {
        let mut folders = vec![
            folder("INBOX", &[]),
            folder("Work", &[]),
            folder("Old", &[]),
        ];
        mark_subscribed(
            &mut folders,
            Some(["Work".to_string()].into_iter().collect()),
        );
        assert!(!folder_is_subscribed(&folders[0]));
        assert!(folder_is_subscribed(&folders[1]));
        assert!(!folder_is_subscribed(&folders[2]));
        assert!(folder_visible(&folders[0], true), "INBOX always visible");
        assert!(!folder_visible(&folders[2], true));
        assert!(folder_visible(&folders[2], false));

        mark_subscribed(&mut folders, Some(HashSet::new()));
        assert!(folders.iter().all(folder_is_subscribed));
        mark_subscribed(&mut folders, None);
        assert!(folders.iter().all(folder_is_subscribed));
        assert_eq!(folders[1].flags, vec![SUBSCRIBED_ATTRIBUTE.to_string()]);
    }

    #[test]
    fn fake_server_lsub_subscribe_and_status() {
        let fake = super::super::fake_imap::FakeImap::start(true);
        fake.add_folder("Work", 2000);
        fake.add_folder("Old", 2001);
        fake.deliver("INBOX", 3, "status");
        let mut session = fake.session();

        imap_set_subscription(&mut session, "Old", false).unwrap();
        let names = imap_subscribed_names(&mut session).unwrap();
        assert!(names.contains("Work") && !names.contains("Old"));
        let mut listed = super::super::imap_list_folders(&mut session, "acct").unwrap();
        let old = listed.iter().find(|f| f.name == "Old").unwrap();
        assert!(!folder_is_subscribed(old));
        imap_set_subscription(&mut session, "Old", true).unwrap();
        mark_subscribed(&mut listed, imap_subscribed_names(&mut session));
        assert!(listed.iter().all(folder_is_subscribed));

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
    fn parses_status_line() {
        let raw = "* STATUS \"Sent Items\" (MESSAGES 12 UNSEEN 3 UIDNEXT 40 UIDVALIDITY 7 HIGHESTMODSEQ 99)\r\na1 OK done\r\n";
        assert_eq!(
            parse_status_response(raw),
            Some(FolderStatus {
                messages: Some(12),
                unseen: Some(3),
                uid_next: Some(40),
                uid_validity: Some(7),
                highest_modseq: Some(99),
            })
        );
        assert_eq!(parse_status_response("a1 NO nope\r\n"), None);
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
