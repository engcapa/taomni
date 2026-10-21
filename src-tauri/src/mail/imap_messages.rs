use super::*;

pub(super) fn imap_list_folders<T: Read + Write>(
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
                flags: name
                    .attributes()
                    .iter()
                    .map(folders::attribute_string)
                    .collect(),
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
    folders::mark_subscribed(&mut listed, folders::imap_subscribed_names(session));
    Ok(listed)
}

pub(super) fn imap_unread_count<T: Read + Write>(
    session: &mut imap::Session<T>,
    _folder: &str,
) -> Option<u32> {
    // Use UID SEARCH UNSEEN for the unread *count* of the currently
    // selected/examined mailbox (caller always EXAMINEs first).
    //
    // STATUS (UNSEEN) via the imap 2.4 crate routes attributes through the
    // unsolicited mpsc channel rather than the returned Mailbox. On some
    // Outlook + proxy paths that left the stream desynced (tag assert panics
    // on the next command). SEARCH is slightly chattier but protocol-stable.
    session
        .uid_search("UNSEEN")
        .ok()
        .map(|ids| ids.len() as u32)
}

/// Select the newest `limit` UIDs at `offset` without a full-folder `SEARCH ALL`
/// when possible. Uses a high UID window near `uid_next`, expanding as needed,
/// and only falls back to `SEARCH ALL` for sparse UID spaces or deep offsets.
pub(super) fn imap_page_uids_newest_first<T: Read + Write>(
    session: &mut imap::Session<T>,
    uid_next: Option<u32>,
    exists: u32,
    offset: usize,
    limit: usize,
) -> Result<(Vec<u32>, bool), String> {
    if exists == 0 || limit == 0 {
        return Ok((Vec::new(), false));
    }
    let need = offset.saturating_add(limit);

    if let Some(uid_next) = uid_next.filter(|u| *u > 1) {
        // Request a generous high-UID window first (gaps mean we may need more).
        let mut window = need.saturating_mul(4).max(need + 64).min(10_000);
        for _ in 0..4 {
            let start = uid_next.saturating_sub(window as u32).max(1);
            let mut uids = session
                .uid_search(format!("UID {start}:*"))
                .map_err(|e| format!("IMAP UID SEARCH range failed: {e}"))?
                .into_iter()
                .collect::<Vec<_>>();
            uids.sort_unstable();
            if uids.len() >= need || start == 1 {
                let total_in_window = uids.len();
                let page: Vec<u32> = uids
                    .iter()
                    .rev()
                    .skip(offset)
                    .take(limit)
                    .copied()
                    .collect();
                // When start==1 the window covers the whole mailbox UID space
                // from 1..uid_next. Otherwise older UIDs may still exist.
                let has_more = if page.is_empty() {
                    false
                } else if start == 1 {
                    offset.saturating_add(page.len()) < total_in_window
                } else {
                    offset.saturating_add(page.len()) < total_in_window
                        || (exists as usize) > offset.saturating_add(page.len())
                };
                let mut page = page;
                page.sort_unstable();
                return Ok((page, has_more));
            }
            // Expand window and retry.
            window = window.saturating_mul(2).min(50_000);
        }
    }

    // Fallback: full SEARCH ALL (slow on large folders).
    let mut uids = session
        .uid_search("ALL")
        .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
        .into_iter()
        .collect::<Vec<_>>();
    uids.sort_unstable();
    let total_uids = uids.len();
    let mut fetch_uids = uids
        .iter()
        .rev()
        .skip(offset)
        .take(limit)
        .copied()
        .collect::<Vec<_>>();
    let has_more = offset.saturating_add(fetch_uids.len()) < total_uids;
    fetch_uids.sort_unstable();
    Ok((fetch_uids, has_more))
}

pub(super) fn imap_sync_folder<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    offset: u32,
    limit: u32,
    include_bodies: bool,
) -> Result<(MailFolder, Vec<MailMessageCached>, bool), String> {
    let mailbox = session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let unread = imap_unread_count(session, folder);
    let account_id = &account.config.session_id;
    let mut folder_info = MailFolder {
        account_id: account_id.clone(),
        name: folder.to_string(),
        display_name: decode_imap_modified_utf7(folder),
        delimiter: None,
        flags: mailbox.flags.iter().map(|flag| flag.to_string()).collect(),
        uid_validity: mailbox.uid_validity,
        uid_next: mailbox.uid_next,
        total: Some(mailbox.exists),
        unread,
        updated_at: now_ts(),
        ..MailFolder::default()
    };

    let offset = offset as usize;
    let limit = limit.max(1).min(2000) as usize;
    let (fetch_uids, has_more) =
        imap_page_uids_newest_first(session, mailbox.uid_next, mailbox.exists, offset, limit)?;
    if fetch_uids.is_empty() {
        folder_info.updated_at = now_ts();
        return Ok((folder_info, Vec::new(), false));
    }

    let mut messages =
        imap_fetch_messages_for_uids(session, account, folder, &fetch_uids, include_bodies)?;
    messages.sort_by(|a, b| {
        b.header
            .date_ts
            .cmp(&a.header.date_ts)
            .then(b.header.uid.cmp(&a.header.uid))
    });
    Ok((folder_info, messages, has_more))
}

pub(super) fn imap_fetch_messages_for_uids<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    fetch_uids: &[u32],
    include_bodies: bool,
) -> Result<Vec<MailMessageCached>, String> {
    if fetch_uids.is_empty() {
        return Ok(Vec::new());
    }
    let account_id = &account.config.session_id;
    let mut messages = Vec::new();
    // Even sparse ten-digit UIDs fit comfortably under a 4 KiB command limit.
    for chunk in fetch_uids.chunks(250) {
        let uid_set = uid_set_string(chunk);
        let fetches = session
            .uid_fetch(
                &uid_set,
                "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])",
            )
            .map_err(|e| format!("IMAP UID FETCH headers failed: {e}"))?;
        for fetch in fetches.iter() {
            if let Some(message) = parse_fetch_header(account_id, folder, fetch) {
                messages.push(message);
            }
        }
    }
    messages.sort_by(|a, b| {
        a.header
            .date_ts
            .cmp(&b.header.date_ts)
            .then(a.header.uid.cmp(&b.header.uid))
    });

    let body_limit = account.config.cache.body_recent_limit as usize;
    if include_bodies && account.config.cache.enabled && body_limit > 0 {
        let body_uids = fetch_uids
            .iter()
            .rev()
            .take(body_limit.min(fetch_uids.len()))
            .copied()
            .collect::<Vec<_>>();
        let mut body_uids = body_uids;
        body_uids.sort_unstable();
        let raw_limit = account
            .config
            .cache
            .body_max_bytes
            .max(1024)
            .min(10 * 1024 * 1024) as usize;
        let body_query = format!("(UID RFC822.SIZE BODY.PEEK[]<0.{raw_limit}>)");
        let mut bodies = HashMap::new();
        for chunk in body_uids.chunks(250) {
            let body_uid_set = uid_set_string(chunk);
            let body_fetches = session
                .uid_fetch(&body_uid_set, &body_query)
                .map_err(|e| format!("IMAP UID FETCH bodies failed: {e}"))?;
            for fetch in body_fetches.iter() {
                if let Some(uid) = fetch.uid {
                    if let Some(body) = fetch.body() {
                        save_raw_message(account, folder, uid, body)?;
                        bodies.insert(
                            uid,
                            parse_body_message(
                                account_id, folder, uid, fetch.size, body, raw_limit,
                            ),
                        );
                    }
                }
            }
        }
        for message in &mut messages {
            if let Some(body) = bodies.remove(&message.header.uid) {
                merge_body(message, body);
            }
        }
    }

    Ok(messages)
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

pub(super) fn uid_set_string(uids: &[u32]) -> String {
    uids.iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}
