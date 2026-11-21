use super::*;
use taomni_mail_engine::imap_messages::Mailbox;

pub(super) use taomni_mail_engine::imap_messages::{imap_fetch_raw, uid_set_string};
pub(super) use taomni_mail_engine::imap_mutations::{
    imap_delete_messages, imap_mark_read, imap_set_flags,
};

pub(super) fn imap_mailbox<'a>(
    account: &'a ResolvedMailAccount,
    folder: &'a str,
) -> Mailbox<'a, impl FnMut(u32, &[u8]) -> Result<(), String> + 'a> {
    Mailbox {
        account_id: &account.config.session_id,
        name: folder,
        cache: &account.config.cache,
        save_original: move |uid, body: &[u8]| save_raw_message(account, folder, uid, body),
    }
}

pub(super) fn imap_sync_folder<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    offset: u32,
    limit: u32,
    include_bodies: bool,
) -> Result<(MailFolder, Vec<MailMessageCached>, bool), String> {
    imap_mailbox(account, folder).fetch_page(session, offset, limit, include_bodies)
}

#[cfg(test)]
pub(super) fn imap_fetch_messages_for_uids<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    fetch_uids: &[u32],
    include_bodies: bool,
) -> Result<Vec<MailMessageCached>, String> {
    imap_mailbox(account, folder).fetch_messages(session, fetch_uids, include_bodies)
}

pub(super) fn imap_fetch_body<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
) -> Result<MailMessageCached, String> {
    imap_mailbox(account, folder).fetch_body(session, uid)
}

pub(super) fn imap_download_attachment<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uid: u32,
    attachment_index: usize,
    target_path: &str,
    section: Option<&str>,
) -> Result<MailDownloadAttachmentResult, String> {
    let attachment = taomni_mail_engine::imap_messages::imap_fetch_attachment(
        session,
        folder,
        uid,
        attachment_index,
        section,
    )?;
    let path = write_attachment_file(target_path, &attachment.bytes)?;
    Ok(MailDownloadAttachmentResult {
        path,
        name: attachment.name,
        content_type: attachment.content_type,
        size: attachment.bytes.len(),
    })
}

pub(super) fn merge_selected_folder(folders: &mut Vec<MailFolder>, selected: MailFolder) {
    if let Some(existing) = folders.iter_mut().find(|f| f.name == selected.name) {
        *existing = folders::merge_folder_status(existing, selected);
    } else {
        folders.push(selected);
    }
}
