//! Outgoing mail on the server (TASK-06): the Sent copy of a sent message and
//! server-side drafts, both stored with IMAP APPEND so other clients see them.
//!
//! A stored copy is found again by its explicit `Message-ID` (`UID SEARCH
//! HEADER Message-ID`), which works without UIDPLUS `APPENDUID` (the `imap`
//! 2.4 crate does not surface response codes of APPEND).

use std::io::{Read, Write};
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use tauri::State;

use super::sync::quote_imap_string;
use super::{
    ActiveImapSession, ImapSessionOpts, MailAccountConfig, MailDraft, MailFolder, MailImapPool,
    MailProvider, MailSendAttachment, MailSendRequest, MailSendResult, MessageBuildOptions,
    ResolvedMailAccount, build_send_message_with, clean_message_id, list_mail_drafts,
    resolve_config, send_smtp_with, with_imap_session, with_mail_db,
};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SpecialFolder {
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

    fn create_name(self) -> &'static str {
        match self {
            Self::Sent => "Sent",
            Self::Drafts => "Drafts",
        }
    }
}

/// Pick the folder for `kind`: SPECIAL-USE attribute first (RFC 6154), then a
/// well-known name of the last path segment.
pub(super) fn special_folder_name(folders: &[MailFolder], kind: SpecialFolder) -> Option<String> {
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

fn imap_append<T: Read + Write>(
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
        .map_err(|e| format!("IMAP APPEND {folder} failed: {e}"))
}

fn imap_uid_by_message_id<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    message_id: &str,
) -> Result<Option<u32>, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let query = format!(
        "HEADER Message-ID {}",
        quote_imap_string(&format!("<{}>", clean_message_id(message_id)))
    );
    let uids = session
        .uid_search(&query)
        .map_err(|e| format!("IMAP UID SEARCH {query} failed: {e}"))?;
    Ok(uids.into_iter().max())
}

fn imap_create<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
) -> Result<(), String> {
    session
        .create(folder)
        .map_err(|e| format!("IMAP CREATE {folder} failed: {e}"))
}

impl ActiveImapSession {
    fn append(&mut self, folder: &str, bytes: &[u8], flags: &[&str]) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => imap_append(session, folder, bytes, flags),
            Self::Plain { session, .. } => imap_append(session, folder, bytes, flags),
        }
    }

    fn uid_by_message_id(&mut self, folder: &str, message_id: &str) -> Result<Option<u32>, String> {
        match self {
            Self::Tls { session, .. } => imap_uid_by_message_id(session, folder, message_id),
            Self::Plain { session, .. } => imap_uid_by_message_id(session, folder, message_id),
        }
    }

    fn create_mailbox(&mut self, folder: &str) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => imap_create(session, folder),
            Self::Plain { session, .. } => imap_create(session, folder),
        }
    }

    /// Resolve (or create) the special folder.
    fn special_folder(
        &mut self,
        account_id: &str,
        kind: SpecialFolder,
        create: bool,
    ) -> Result<Option<String>, String> {
        let folders = self.list_folders(account_id)?;
        if let Some(name) = special_folder_name(&folders, kind) {
            return Ok(Some(name));
        }
        if !create {
            return Ok(None);
        }
        let name = kind.create_name().to_string();
        self.create_mailbox(&name)?;
        Ok(Some(name))
    }
}

/// Server location of a draft's stored copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RemoteDraftLocation {
    pub folder: String,
    pub uid: u32,
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

/// SMTP send, then (best effort, never failing the send) store the Sent copy
/// and remove the draft's server copy.
pub(super) fn send_and_store_copy(
    pool: &MailImapPool,
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
    remote_draft: Option<RemoteDraftLocation>,
    runtime: &tokio::runtime::Handle,
) -> Result<MailSendResult, String> {
    let message_id = new_message_id(&account.config.email_address);
    let mut result = send_smtp_with(
        account,
        request,
        runtime,
        &MessageBuildOptions {
            message_id: Some(message_id.clone()),
            ..MessageBuildOptions::default()
        },
    )?;
    let save_copy = save_sent_copy_enabled(&account.config);
    if !save_copy && remote_draft.is_none() {
        return Ok(result);
    }
    let copy = if save_copy {
        Some(
            build_send_message_with(
                account,
                request,
                &MessageBuildOptions {
                    message_id: Some(message_id),
                    keep_bcc: true,
                    self_envelope: false,
                },
            )?
            .formatted(),
        )
    } else {
        None
    };
    let account_id = account.config.session_id.clone();
    let stored = with_imap_session(pool, account, runtime, ImapSessionOpts::default(), |imap| {
        let mut sent_folder = None;
        if let Some(bytes) = &copy {
            let folder = imap
                .special_folder(&account_id, SpecialFolder::Sent, true)?
                .ok_or_else(|| "no Sent folder".to_string())?;
            imap.append(&folder, bytes, &["\\Seen"])?;
            sent_folder = Some(folder);
        }
        if let Some(draft) = &remote_draft {
            if let Err(e) = imap.delete_messages(&draft.folder, &[draft.uid], false) {
                tracing::debug!("mail: removing server draft after send failed: {e}");
            }
        }
        Ok(sent_folder)
    });
    match stored {
        Ok(folder) => result.sent_copy_folder = folder,
        Err(e) => {
            if save_copy {
                result.sent_copy_error = Some(e);
            }
        }
    }
    Ok(result)
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
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let op_account_id = account_id.clone();
    let location = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| {
                let folder = imap
                    .special_folder(&op_account_id, SpecialFolder::Drafts, true)?
                    .ok_or_else(|| "no Drafts folder".to_string())?;
                imap.append(&folder, &bytes, &["\\Draft", "\\Seen"])?;
                let uid = imap.uid_by_message_id(&folder, &message_id)?;
                if let Some(previous) = &previous {
                    if Some(previous.uid) != uid || previous.folder != folder {
                        if let Err(e) =
                            imap.delete_messages(&previous.folder, &[previous.uid], false)
                        {
                            tracing::debug!("mail: replacing server draft left the old copy: {e}");
                        }
                    }
                }
                Ok(uid.map(|uid| RemoteDraftLocation { folder, uid }))
            },
        )
    })
    .await
    .map_err(|e| format!("mail draft task failed: {e}"))??;
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
    let account = resolve_config(&state, config)?;
    let account_id = account.config.session_id.clone();
    let Some(location) = with_mail_db(&state, &account_id, |db| {
        remote_draft_location(db, &account_id, &draft_id)
    })?
    else {
        return Ok(false);
    };
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let target = location.clone();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| imap.delete_messages(&target.folder, &[target.uid], false),
        )
    })
    .await
    .map_err(|e| format!("mail draft task failed: {e}"))??;
    with_mail_db(&state, &account_id, |db| {
        set_remote_draft_location(db, &account_id, &draft_id, None)
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::super::fake_imap::FakeImap;
    use super::*;

    fn folder(name: &str, flags: &[&str]) -> MailFolder {
        MailFolder {
            account_id: "acct".into(),
            name: name.into(),
            display_name: name.into(),
            delimiter: Some("/".into()),
            flags: flags.iter().map(|flag| flag.to_string()).collect(),
            ..MailFolder::default()
        }
    }

    #[test]
    fn special_folder_prefers_special_use_then_names() {
        let folders = vec![
            folder("INBOX", &[]),
            folder("Sent", &[]),
            folder("[Gmail]/Sent Mail", &["Custom(\"\\\\Sent\")"]),
            folder("草稿箱", &[]),
        ];
        assert_eq!(
            special_folder_name(&folders, SpecialFolder::Sent).as_deref(),
            Some("[Gmail]/Sent Mail")
        );
        assert_eq!(
            special_folder_name(&folders, SpecialFolder::Drafts).as_deref(),
            Some("草稿箱")
        );
        assert_eq!(
            special_folder_name(&folders[..1], SpecialFolder::Sent),
            None
        );
    }

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
        let uid = imap_uid_by_message_id(&mut session, "Drafts", &id).unwrap();
        assert_eq!(uid, Some(1));
        assert_eq!(fake.flags("Drafts", 1), vec!["\\Draft", "\\Seen"]);
        assert_eq!(
            imap_uid_by_message_id(&mut session, "Drafts", "<missing@example.com>").unwrap(),
            None
        );
    }
}
