use crate::{
    HeaderInput, MailFolder, MailMessageCached, cache::MailCacheSettings, empty_cached_message,
    imap_folders::decode_imap_modified_utf7, merge_body, now_ts, parse_body_message, parse_header,
};
use std::{
    collections::HashMap,
    io::{Read, Write},
};

/// A mailbox and its fetch policy, independent of the host's account and file services.
pub struct Mailbox<'a, SaveOriginal> {
    pub account_id: &'a str,
    pub name: &'a str,
    pub cache: &'a MailCacheSettings,
    pub save_original: SaveOriginal,
}

impl<SaveOriginal> Mailbox<'_, SaveOriginal>
where
    SaveOriginal: FnMut(u32, &[u8]) -> Result<(), String>,
{
    pub fn fetch_page<T: Read + Write>(
        &mut self,
        session: &mut imap::Session<T>,
        offset: u32,
        limit: u32,
        include_bodies: bool,
    ) -> Result<(MailFolder, Vec<MailMessageCached>, bool), String> {
        let folder = self.name;
        let mailbox = session
            .examine(folder)
            .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
        let unread = imap_unread_count(session);
        let mut folder_info = MailFolder {
            account_id: self.account_id.to_owned(),
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

        let mut messages = self.fetch_messages(session, &fetch_uids, include_bodies)?;
        messages.sort_by(|a, b| {
            b.header
                .date_ts
                .cmp(&a.header.date_ts)
                .then(b.header.uid.cmp(&a.header.uid))
        });
        Ok((folder_info, messages, has_more))
    }

    pub fn fetch_body<T: Read + Write>(
        &mut self,
        session: &mut imap::Session<T>,
        uid: u32,
    ) -> Result<MailMessageCached, String> {
        let folder = self.name;
        session
            .examine(folder)
            .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
        let raw_limit = self.cache.body_max_bytes.clamp(1024, 10 * 1024 * 1024) as usize;
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
        let mut message = parse_fetch_header(self.account_id, folder, fetch)
            .unwrap_or_else(|| empty_cached_message(self.account_id, folder, uid));
        let truncated = fetch.size.is_some_and(|size| size as usize > raw_limit);
        if let Some(body) = fetch.body() {
            if !truncated {
                (self.save_original)(uid, body)?;
            }
            let parsed =
                parse_body_message(self.account_id, folder, uid, fetch.size, body, raw_limit);
            merge_body(&mut message, parsed);
        }
        if truncated {
            // TASK-15: the partial fetch cut the message; read the text parts
            // whole and list every attachment from BODYSTRUCTURE instead.
            match crate::imap_parts::imap_fetch_large_body(session, uid) {
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
                Err(e) => tracing::debug!("mail: BODYSTRUCTURE fallback failed for UID {uid}: {e}"),
            }
        }
        Ok(message)
    }

    pub fn fetch_messages<T: Read + Write>(
        &mut self,
        session: &mut imap::Session<T>,
        fetch_uids: &[u32],
        include_bodies: bool,
    ) -> Result<Vec<MailMessageCached>, String> {
        if fetch_uids.is_empty() {
            return Ok(Vec::new());
        }
        let account_id = self.account_id;
        let folder = self.name;
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

        let body_limit = self.cache.body_recent_limit as usize;
        if include_bodies && self.cache.enabled && body_limit > 0 {
            let body_uids = fetch_uids
                .iter()
                .rev()
                .take(body_limit.min(fetch_uids.len()))
                .copied()
                .collect::<Vec<_>>();
            let mut body_uids = body_uids;
            body_uids.sort_unstable();
            let raw_limit = self.cache.body_max_bytes.clamp(1024, 10 * 1024 * 1024) as usize;
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
                            (self.save_original)(uid, body)?;
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
}

pub(crate) fn imap_unread_count<T: Read + Write>(session: &mut imap::Session<T>) -> Option<u32> {
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
pub(crate) fn imap_page_uids_newest_first<T: Read + Write>(
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

fn parse_fetch_header(
    account_id: &str,
    folder: &str,
    fetch: &imap::types::Fetch,
) -> Option<MailMessageCached> {
    Some(parse_header(HeaderInput {
        account_id,
        folder,
        uid: fetch.uid?,
        header: fetch.header().unwrap_or_default(),
        flags: fetch_flag_strings(fetch),
        internal_date: fetch.internal_date().map(|date| date.timestamp()),
        raw_size: fetch.size,
    }))
}

/// FLAGS of a FETCH response as cache strings. `\Recent` is session-scoped
/// and never persisted.
pub(crate) fn fetch_flag_strings(fetch: &imap::types::Fetch) -> Vec<String> {
    fetch
        .flags()
        .iter()
        .map(|flag| flag.to_string())
        .filter(|flag| !flag.eq_ignore_ascii_case("\\Recent"))
        .collect()
}

pub fn uid_set_string(uids: &[u32]) -> String {
    uids.iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

pub fn imap_fetch_raw<T: Read + Write>(
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

pub fn imap_fetch_attachment<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uid: u32,
    index: usize,
    section: Option<&str>,
) -> Result<crate::DownloadedMailAttachment, String> {
    session
        .examine(folder)
        .map_err(|error| format!("IMAP EXAMINE {folder} failed: {error}"))?;
    if let Some(section) = section {
        return Ok(crate::DownloadedMailAttachment {
            name: None,
            content_type: None,
            bytes: crate::imap_parts::imap_fetch_section(session, uid, section)?,
        });
    }
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .map_err(|error| format!("IMAP UID FETCH attachment failed: {error}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let body = fetch
        .body()
        .ok_or_else(|| format!("message UID {uid} did not include a body"))?;
    crate::extract_attachment(body, index)
}
