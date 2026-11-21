//! Mailbox selection and APPEND behavior shared by both IMAP adapters.

use std::io::{Read, Write};

use taomni_mail_api::{ImapFolderChange, RemoteDraftLocation};

use crate::{
    MailFolder,
    imap_folders::{imap_change_folder, imap_list_folders},
    imap_mutations::imap_delete_messages,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecialFolder {
    Sent,
    Drafts,
}

impl SpecialFolder {
    fn attribute(self) -> &'static str {
        match self {
            Self::Sent => "\\sent",
            Self::Drafts => "\\drafts",
        }
    }

    fn names(self) -> &'static [&'static str] {
        match self {
            Self::Sent => &[
                "sent",
                "sent items",
                "sent messages",
                "sent mail",
                "已发送",
                "已發送",
                "已傳送",
                "寄件备份",
                "已发送邮件",
            ],
            Self::Drafts => &["drafts", "draft", "草稿", "草稿箱", "草稿夹"],
        }
    }

    pub fn override_key(self) -> &'static str {
        match self {
            Self::Sent => "sent",
            Self::Drafts => "drafts",
        }
    }

    pub fn create_name(self) -> &'static str {
        match self {
            Self::Sent => "Sent",
            Self::Drafts => "Drafts",
        }
    }
}

/// Match a configured wire or display name, then RFC 6154 and common names.
pub fn special_folder_name(
    folders: &[MailFolder],
    kind: SpecialFolder,
    configured: Option<&str>,
) -> Option<String> {
    if let Some(wanted) = configured
        .map(str::trim)
        .filter(|wanted| !wanted.is_empty())
        && let Some(folder) = folders
            .iter()
            .find(|folder| folder.name == wanted || folder.display_name == wanted)
    {
        return Some(folder.name.clone());
    }
    let attribute = kind.attribute();
    if let Some(folder) = folders.iter().find(|folder| {
        folder
            .flags
            .iter()
            .any(|flag| flag.to_ascii_lowercase().contains(attribute))
    }) {
        return Some(folder.name.clone());
    }
    for name in kind.names() {
        if let Some(folder) = folders.iter().find(|folder| {
            let delimiter = folder.delimiter.as_deref().unwrap_or("/");
            let label = folder.display_name.as_str();
            let last = label.rsplit(delimiter).next().unwrap_or(label);
            last.trim().to_lowercase() == *name
        }) {
            return Some(folder.name.clone());
        }
    }
    None
}

pub fn imap_append<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    bytes: &[u8],
    flags: &[&str],
) -> Result<(), String> {
    let flags: Vec<imap::types::Flag<'_>> = flags
        .iter()
        .map(|flag| imap::types::Flag::from(flag.to_string()))
        .collect();
    session
        .append_with_flags(folder, bytes, &flags)
        .map_err(|error| format!("IMAP APPEND {folder} failed: {error}"))
}

pub fn store_sent_copy<T: Read + Write>(
    session: &mut imap::Session<T>,
    account_id: &str,
    configured_folder: Option<&str>,
    bytes: Option<&[u8]>,
    remote_draft: Option<&RemoteDraftLocation>,
) -> Result<Option<String>, String> {
    let sent_folder = if let Some(bytes) = bytes {
        let kind = SpecialFolder::Sent;
        let folders = imap_list_folders(session, account_id)?;
        let folder = match special_folder_name(&folders, kind, configured_folder) {
            Some(folder) => folder,
            None => {
                let name = kind.create_name().to_owned();
                imap_change_folder(session, &ImapFolderChange::Create { name: name.clone() })?;
                name
            }
        };
        imap_append(session, &folder, bytes, &["\\Seen"])?;
        Some(folder)
    } else {
        None
    };
    if let Some(draft) = remote_draft
        && let Err(error) = imap_delete_messages(session, &draft.folder, &[draft.uid], false)
    {
        tracing::debug!(%error, "mail: removing server draft after send failed");
    }
    Ok(sent_folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str, display_name: &str, flags: &[&str]) -> MailFolder {
        MailFolder {
            name: name.into(),
            display_name: display_name.into(),
            delimiter: Some("/".into()),
            flags: flags.iter().map(|flag| flag.to_string()).collect(),
            ..MailFolder::default()
        }
    }

    #[test]
    fn resolves_override_then_special_use_then_known_name() {
        let folders = [
            folder("INBOX", "INBOX", &[]),
            folder("Sent", "Sent", &[]),
            folder("[Gmail]/Sent Mail", "[Gmail]/Sent Mail", &["\\Sent"]),
            folder("&g0l6P3ux-", "草稿箱", &[]),
        ];
        assert_eq!(
            special_folder_name(&folders, SpecialFolder::Sent, Some(" 草稿箱 ")).as_deref(),
            Some("&g0l6P3ux-"),
        );
        assert_eq!(
            special_folder_name(&folders, SpecialFolder::Sent, Some("Missing")).as_deref(),
            Some("[Gmail]/Sent Mail"),
        );
        assert_eq!(
            special_folder_name(&folders, SpecialFolder::Drafts, None).as_deref(),
            Some("&g0l6P3ux-"),
        );
        assert_eq!(
            special_folder_name(&folders[..1], SpecialFolder::Sent, None),
            None
        );
    }
}
