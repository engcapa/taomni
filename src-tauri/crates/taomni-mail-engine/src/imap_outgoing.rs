//! Mailbox selection and APPEND behavior shared by both IMAP adapters.

#[cfg(feature = "imap-runtime")]
use std::io::{Read, Write};

#[cfg(feature = "imap-runtime")]
use taomni_mail_api::{ImapFolderChange, RemoteDraftLocation};

#[cfg(feature = "imap-runtime")]
use crate::{
    clean_message_id,
    imap_folders::{imap_change_folder, imap_list_folders, quote_imap_string},
    imap_mutations::imap_delete_messages,
};

pub use taomni_mail_storage::imap_outgoing::*;

#[cfg(feature = "imap-runtime")]
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

#[cfg(feature = "imap-runtime")]
pub fn store_sent_copy<T: Read + Write>(
    session: &mut imap::Session<T>,
    account_id: &str,
    configured_folder: Option<&str>,
    bytes: Option<&[u8]>,
    remote_draft: Option<&RemoteDraftLocation>,
) -> Result<Option<String>, String> {
    let sent_folder = if let Some(bytes) = bytes {
        let folder = ensure_folder(session, account_id, SpecialFolder::Sent, configured_folder)?;
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

#[cfg(feature = "imap-runtime")]
pub fn store_remote_draft<T: Read + Write>(
    session: &mut imap::Session<T>,
    account_id: &str,
    configured_folder: Option<&str>,
    bytes: &[u8],
    message_id: &str,
    previous: Option<&RemoteDraftLocation>,
) -> Result<Option<RemoteDraftLocation>, String> {
    let folder = ensure_folder(
        session,
        account_id,
        SpecialFolder::Drafts,
        configured_folder,
    )?;
    imap_append(session, &folder, bytes, &["\\Draft", "\\Seen"])?;
    let uid = uid_by_message_id(session, &folder, message_id)?
        .ok_or("The server accepted the draft but did not return its UID. Check the Drafts folder before saving again.")?;
    if let Some(previous) = previous
        && (previous.uid != uid || previous.folder != folder)
        && let Err(error) = imap_delete_messages(session, &previous.folder, &[previous.uid], false)
    {
        tracing::debug!(%error, "mail: replacing server draft left the old copy");
    }
    Ok(Some(RemoteDraftLocation { folder, uid }))
}

#[cfg(feature = "imap-runtime")]
fn ensure_folder<T: Read + Write>(
    session: &mut imap::Session<T>,
    account_id: &str,
    kind: SpecialFolder,
    configured_folder: Option<&str>,
) -> Result<String, String> {
    let folders = imap_list_folders(session, account_id)?;
    if let Some(folder) = special_folder_name(&folders, kind, configured_folder) {
        return Ok(folder);
    }
    let name = kind.create_name().to_owned();
    imap_change_folder(session, &ImapFolderChange::Create { name: name.clone() })?;
    Ok(name)
}

#[cfg(feature = "imap-runtime")]
pub fn uid_by_message_id<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    message_id: &str,
) -> Result<Option<u32>, String> {
    session
        .examine(folder)
        .map_err(|error| format!("IMAP EXAMINE {folder} failed: {error}"))?;
    let query = format!(
        "HEADER Message-ID {}",
        quote_imap_string(&format!("<{}>", clean_message_id(message_id)))
    );
    session
        .uid_search(&query)
        .map(|uids| uids.into_iter().max())
        .map_err(|error| format!("IMAP UID SEARCH {query} failed: {error}"))
}
