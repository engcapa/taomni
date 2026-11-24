//! IMAP folder names and subscription flags used in persisted mail.

use crate::MailFolder;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64_STANDARD};

pub const SUBSCRIBED_ATTRIBUTE: &str = "\\Subscribed";

fn folder_is_inbox(folder: &MailFolder) -> bool {
    folder.name.eq_ignore_ascii_case("INBOX")
}

pub fn folder_is_subscribed(folder: &MailFolder) -> bool {
    folder
        .flags
        .iter()
        .any(|flag| flag.eq_ignore_ascii_case(SUBSCRIBED_ATTRIBUTE))
}

/// Whether the tree/sync should include `folder` under `subscribed_only`.
pub fn folder_visible(folder: &MailFolder, subscribed_only: bool) -> bool {
    !subscribed_only || folder_is_inbox(folder) || folder_is_subscribed(folder)
}

/// Quote a mailbox name for a raw IMAP command.
pub fn quote_imap_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        if ch != '\r' && ch != '\n' {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

pub fn decode_imap_modified_utf7(input: &str) -> String {
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

fn decode_imap_modified_utf7_segment(encoded: &str) -> Option<String> {
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
