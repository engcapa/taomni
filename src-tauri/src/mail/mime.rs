use super::*;
use taomni_mail_engine::{HeaderInput, parse_header};

pub(super) use taomni_mail_engine::{
    clean_message_id, empty_cached_message, extract_attachment, extract_attachment_section,
    merge_body, parse_body_message, thread_references, truncate_utf8_bytes,
};

#[cfg(test)]
pub(super) use taomni_mail_engine::{attachment_info, header_message_ids};

pub(super) fn parse_fetch_header(
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
pub(super) fn fetch_flag_strings(fetch: &imap::types::Fetch) -> Vec<String> {
    fetch
        .flags()
        .iter()
        .map(|flag| flag.to_string())
        .filter(|flag| !flag.eq_ignore_ascii_case("\\Recent"))
        .collect()
}

pub(super) use taomni_mail_engine::imap_folders::decode_imap_modified_utf7;
