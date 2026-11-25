use std::collections::HashMap;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use mail_parser::{MimeHeaders, PartType};

use crate::clean_message_id;

/// Skip individual CID parts larger than this when rewriting for display.
const MAX_INLINE_CID_IMAGE_BYTES: usize = 2 * 1024 * 1024;

/// Rewrite `src="cid:..."` / `src='cid:...'` references to data URLs using matching
/// MIME parts (Content-ID). Enables embedded images in the HTML reader without
/// requiring a separate attachment download round-trip.
pub(super) fn rewrite_cid_images_in_html(message: &mail_parser::Message<'_>, html: &str) -> String {
    if !html.to_ascii_lowercase().contains("cid:") {
        return html.to_string();
    }

    let mut by_cid: HashMap<String, (String, Vec<u8>)> = HashMap::new();
    for part in &message.parts {
        let Some(raw_cid) = part.content_id() else {
            continue;
        };
        let cid = clean_message_id(raw_cid);
        if cid.is_empty() {
            continue;
        }
        let content_type = part
            .content_type()
            .map(|ct| match ct.c_subtype.as_ref() {
                Some(subtype) => format!("{}/{}", ct.c_type, subtype),
                None => ct.c_type.to_string(),
            })
            .unwrap_or_else(|| "application/octet-stream".into());
        // Only embed image/* parts — other cid targets (e.g. calendar) stay as cid:.
        if !content_type.to_ascii_lowercase().starts_with("image/") {
            continue;
        }
        let bytes = match &part.body {
            PartType::Binary(b) | PartType::InlineBinary(b) => b.as_ref().to_vec(),
            PartType::Text(s) | PartType::Html(s) => s.as_ref().as_bytes().to_vec(),
            PartType::Message(nested) => nested.raw_message.to_vec(),
            PartType::Multipart(_) => continue,
        };
        if bytes.is_empty() || bytes.len() > MAX_INLINE_CID_IMAGE_BYTES {
            continue;
        }
        by_cid.insert(cid.to_ascii_lowercase(), (content_type, bytes));
    }
    if by_cid.is_empty() {
        return html.to_string();
    }

    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let rest = &html[index..];
        let lower = rest.to_ascii_lowercase();
        let Some(rel_src) = lower.find("src=") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..rel_src + 4]);
        index += rel_src + 4;
        if index >= bytes.len() {
            break;
        }
        let quote = html.as_bytes()[index];
        let (quote_char, value_start) = if quote == b'"' || quote == b'\'' {
            (Some(quote as char), index + 1)
        } else {
            (None, index)
        };
        let value_end = match quote_char {
            Some(q) => html[value_start..]
                .find(q)
                .map(|n| value_start + n)
                .unwrap_or(html.len()),
            None => {
                let end_rel = html[value_start..]
                    .find(|c: char| c.is_whitespace() || c == '>')
                    .unwrap_or(html[value_start..].len());
                value_start + end_rel
            }
        };
        let raw_src = &html[value_start..value_end];
        let cid_key = raw_src
            .trim()
            .strip_prefix("cid:")
            .or_else(|| raw_src.trim().strip_prefix("CID:"))
            .map(|v| clean_message_id(v).to_ascii_lowercase());
        if let Some(cid) = cid_key.as_ref() {
            if let Some((content_type, data)) = by_cid.get(cid) {
                let encoded = STANDARD.encode(data);
                if let Some(q) = quote_char {
                    out.push(q);
                    out.push_str("data:");
                    out.push_str(content_type);
                    out.push_str(";base64,");
                    out.push_str(&encoded);
                    out.push(q);
                } else {
                    out.push_str("data:");
                    out.push_str(content_type);
                    out.push_str(";base64,");
                    out.push_str(&encoded);
                }
                index = if quote_char.is_some() {
                    value_end + 1
                } else {
                    value_end
                };
                continue;
            }
        }
        // Unmatched cid or non-cid src: copy through unchanged.
        if let Some(q) = quote_char {
            out.push(q);
            out.push_str(raw_src);
            out.push(q);
            index = value_end + 1;
        } else {
            out.push_str(raw_src);
            index = value_end;
        }
    }
    out
}
