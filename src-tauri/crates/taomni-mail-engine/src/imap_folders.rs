//! IMAP mailbox naming, subscriptions and change detection over an established connection.

#[cfg(any(feature = "imap-runtime", test))]
use std::collections::HashSet;
#[cfg(feature = "imap-runtime")]
use std::io::{Read, Write};

#[cfg(feature = "imap-runtime")]
use imap::types::NameAttribute;
#[cfg(feature = "imap-runtime")]
use taomni_mail_api::ImapFolderChange;
pub use taomni_mail_storage::imap_folders::*;

use crate::MailFolder;
#[cfg(feature = "imap-runtime")]
use crate::now_ts;

#[cfg(feature = "imap-runtime")]
pub fn imap_change_folder<T: Read + Write>(
    session: &mut imap::Session<T>,
    change: &ImapFolderChange,
) -> Result<(), String> {
    match change {
        ImapFolderChange::Create { name } => session
            .create(name)
            .map_err(|error| format!("IMAP CREATE {name} failed: {error}")),
        ImapFolderChange::Rename { from, to } => session
            .rename(from, to)
            .map_err(|error| format!("IMAP RENAME {from} -> {to} failed: {error}")),
        ImapFolderChange::Delete { name } => session
            .delete(name)
            .map_err(|error| format!("IMAP DELETE {name} failed: {error}")),
    }
}

/// RFC wire form of a LIST attribute (the `imap` crate only has Debug output).
#[cfg(feature = "imap-runtime")]
fn attribute_string(attribute: &NameAttribute<'_>) -> String {
    match attribute {
        NameAttribute::NoInferiors => "\\Noinferiors".into(),
        NameAttribute::NoSelect => "\\Noselect".into(),
        NameAttribute::Marked => "\\Marked".into(),
        NameAttribute::Unmarked => "\\Unmarked".into(),
        NameAttribute::Custom(value) => value.to_string(),
    }
}

/// Mark LSUB-reported folders `\Subscribed`. An empty or failed LSUB means
/// the server does not track subscriptions: every folder counts as subscribed
/// so "subscribed only" never hides a whole account.
#[cfg(any(feature = "imap-runtime", test))]
fn mark_subscribed(folders: &mut [MailFolder], subscribed: Option<HashSet<String>>) {
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

#[cfg(feature = "imap-runtime")]
fn imap_subscribed_names<T: Read + Write>(
    session: &mut imap::Session<T>,
) -> Option<HashSet<String>> {
    session
        .lsub(Some(""), Some("*"))
        .ok()
        .map(|names| names.iter().map(|name| name.name().to_string()).collect())
}

#[cfg(feature = "imap-runtime")]
pub fn imap_set_subscription<T: Read + Write>(
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
pub struct FolderStatus {
    pub messages: Option<u32>,
    pub unseen: Option<u32>,
    pub uid_next: Option<u32>,
    pub uid_validity: Option<u32>,
    pub highest_modseq: Option<u64>,
}

/// Parse `* STATUS <name> (KEY value ...)` from a raw response.
#[cfg(any(feature = "imap-runtime", test))]
fn parse_status_response(raw: &str) -> Option<FolderStatus> {
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
#[cfg(feature = "imap-runtime")]
pub fn imap_folder_status<T: Read + Write>(
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

#[cfg(feature = "imap-runtime")]
pub fn imap_list_folders<T: Read + Write>(
    session: &mut imap::Session<T>,
    account_id: &str,
) -> Result<Vec<MailFolder>, String> {
    let names = session
        .list(None, Some("*"))
        .map_err(|e| format!("IMAP LIST failed: {e}"))?;
    let now = now_ts();
    let mut listed: Vec<MailFolder> = names
        .iter()
        .map(|name| {
            let raw_name = name.name().to_string();
            MailFolder {
                account_id: account_id.to_string(),
                display_name: decode_imap_modified_utf7(&raw_name),
                name: raw_name,
                delimiter: name.delimiter().map(ToOwned::to_owned),
                flags: name.attributes().iter().map(attribute_string).collect(),
                uid_validity: None,
                uid_next: None,
                total: None,
                unread: None,
                updated_at: now,
                ..MailFolder::default()
            }
        })
        .collect();
    drop(names);
    mark_subscribed(&mut listed, imap_subscribed_names(session));
    Ok(listed)
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

    #[cfg(feature = "imap-runtime")]
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
}
