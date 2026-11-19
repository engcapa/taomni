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

pub(super) fn decode_imap_modified_utf7(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let rest = &input[index..];
        if !rest.starts_with('&') {
            let ch = rest.chars().next().unwrap_or_default();
            out.push(ch);
            index += ch.len_utf8();
            continue;
        }

        let after_amp = index + 1;
        let Some(relative_end) = input[after_amp..].find('-') else {
            out.push_str(rest);
            break;
        };
        let end = after_amp + relative_end;
        let encoded = &input[after_amp..end];
        if encoded.is_empty() {
            out.push('&');
            index = end + 1;
            continue;
        }

        match decode_imap_modified_utf7_segment(encoded) {
            Some(decoded) => out.push_str(&decoded),
            None => out.push_str(&input[index..=end]),
        }
        index = end + 1;
    }
    out
}

pub(super) fn decode_imap_modified_utf7_segment(encoded: &str) -> Option<String> {
    let mut b64 = encoded.replace(',', "/");
    while b64.len() % 4 != 0 {
        b64.push('=');
    }
    let bytes = BASE64_STANDARD.decode(b64.as_bytes()).ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units).ok()
}
