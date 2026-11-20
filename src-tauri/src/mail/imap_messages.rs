use super::*;
use taomni_mail_engine::imap_messages::{Mailbox, parse_fetch_header};

pub(super) use taomni_mail_engine::imap_messages::uid_set_string;

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
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let raw_limit = account
        .config
        .cache
        .body_max_bytes
        .max(1024)
        .min(10 * 1024 * 1024) as usize;
    let query = format!(
        "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER] BODY.PEEK[]<0.{raw_limit}>)"
    );
    let fetches = session
        .uid_fetch(uid.to_string(), query)
        .map_err(|e| format!("IMAP UID FETCH body failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let mut message = parse_fetch_header(&account.config.session_id, folder, fetch)
        .unwrap_or_else(|| empty_cached_message(&account.config.session_id, folder, uid));
    let truncated = fetch.size.is_some_and(|size| size as usize > raw_limit);
    if let Some(body) = fetch.body() {
        if !truncated {
            save_raw_message(account, folder, uid, body)?;
        }
        let parsed = parse_body_message(
            &account.config.session_id,
            folder,
            uid,
            fetch.size,
            body,
            raw_limit,
        );
        merge_body(&mut message, parsed);
    }
    if truncated {
        // TASK-15: the partial fetch cut the message; read the text parts
        // whole and list every attachment from BODYSTRUCTURE instead.
        match parts::imap_fetch_large_body(session, uid) {
            Ok(large) => {
                if large.text.is_some() || large.html.is_some() {
                    message.body_text = large.text;
                    message.body_html = large.html;
                }
                if !large.attachments.is_empty() {
                    message.header.has_attachments = true;
                    message.header.attachment_count = large.attachments.len();
                    message.header.attachments = large.attachments;
                }
            }
            Err(e) => log::debug!("mail: BODYSTRUCTURE fallback failed for UID {uid}: {e}"),
        }
    }
    Ok(message)
}

pub(super) fn imap_mark_read<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
) -> Result<usize, String> {
    if uids.is_empty() {
        return Ok(0);
    }
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    for batch in uids.chunks(read_actions::UID_BATCH_SIZE) {
        session
            .uid_store(uid_set_string(batch), "+FLAGS.SILENT (\\Seen)")
            .map_err(|e| format!("IMAP UID STORE \\Seen failed: {e}"))?;
    }
    Ok(uids.len())
}

pub(super) fn imap_set_flags<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> Result<usize, String> {
    if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(0);
    }
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    for batch in uids.chunks(read_actions::UID_BATCH_SIZE) {
        let uid_set = uid_set_string(batch);
        if !add.is_empty() {
            let query = format!("+FLAGS.SILENT ({})", add.join(" "));
            session
                .uid_store(&uid_set, &query)
                .map_err(|e| format!("IMAP UID STORE +FLAGS failed: {e}"))?;
        }
        if !remove.is_empty() {
            let query = format!("-FLAGS.SILENT ({})", remove.join(" "));
            session
                .uid_store(&uid_set, &query)
                .map_err(|e| format!("IMAP UID STORE -FLAGS failed: {e}"))?;
        }
    }
    Ok(uids.len())
}

pub(super) fn imap_delete_messages<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    all: bool,
) -> Result<usize, String> {
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    let uid_list: Vec<u32> = if all {
        session
            .uid_search("ALL")
            .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
            .into_iter()
            .collect()
    } else {
        uids.to_vec()
    };
    if uid_list.is_empty() {
        return Ok(0);
    }
    let caps = session
        .capabilities()
        .map_err(|e| format!("IMAP CAPABILITY failed: {e}"))?;
    if !caps.has_str("UIDPLUS") {
        return Err("Server cannot safely delete only these messages (UIDPLUS unavailable)".into());
    }
    for batch in uid_list.chunks(50) {
        let uid_set = uid_set_string(batch);
        session
            .uid_store(&uid_set, "+FLAGS.SILENT (\\Deleted)")
            .map_err(|e| format!("IMAP UID STORE failed: {e}"))?;
        session
            .uid_expunge(&uid_set)
            .map_err(|e| format!("IMAP UID EXPUNGE failed: {e}"))?;
    }
    Ok(uid_list.len())
}

pub(super) fn imap_fetch_raw<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .map_err(|e| format!("IMAP UID FETCH raw failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let body = fetch
        .body()
        .ok_or_else(|| format!("message UID {uid} did not include a body"))?;
    Ok(body.to_vec())
}

pub(super) fn imap_download_attachment<T: Read + Write>(
    session: &mut imap::Session<T>,
    _account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
    attachment_index: usize,
    target_path: &str,
    section: Option<&str>,
) -> Result<MailDownloadAttachmentResult, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    if let Some(section) = section {
        let bytes = parts::imap_fetch_section(session, uid, section)?;
        let path = write_attachment_file(target_path, &bytes)?;
        return Ok(MailDownloadAttachmentResult {
            path,
            name: None,
            content_type: None,
            size: bytes.len(),
        });
    }
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .map_err(|e| format!("IMAP UID FETCH attachment failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let body = fetch
        .body()
        .ok_or_else(|| format!("message UID {uid} did not include a body"))?;
    let attachment = extract_attachment(body, attachment_index)?;
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
        *existing = selected;
    } else {
        folders.push(selected);
    }
}
