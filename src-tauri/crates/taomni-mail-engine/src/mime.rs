#[cfg(feature = "mime-parse")]
use mail_parser::{Address, MessageParser, MimeHeaders, PartType};

#[cfg(feature = "mime-parse")]
use crate::inline_images::rewrite_cid_images_in_html;
#[cfg(feature = "mime-parse")]
use crate::{
    DownloadedMailAttachment, MailAddress, MailAttachmentInfo, now_ts, parse_list_unsubscribe,
};
use crate::{MailMessageCached, MailMessageHeader};

/// Cap for HTML bodies after embedding inline CID images as data URLs.
#[cfg(feature = "mime-parse")]
const MAX_EMBEDDED_BODY_BYTES: usize = 5 * 1024 * 1024;

#[cfg(feature = "mime-parse")]
pub struct HeaderInput<'a> {
    pub account_id: &'a str,
    pub folder: &'a str,
    pub uid: u32,
    pub header: &'a [u8],
    pub flags: Vec<String>,
    pub internal_date: Option<i64>,
    pub raw_size: Option<u32>,
}

#[cfg(feature = "mime-parse")]
pub fn parse_header(input: HeaderInput<'_>) -> MailMessageCached {
    let HeaderInput {
        account_id,
        folder,
        uid,
        header,
        flags,
        internal_date: fallback_date,
        raw_size,
    } = input;
    let parsed = MessageParser::default().parse(header);
    let list_unsubscribe = parsed.as_ref().and_then(|message| {
        parse_list_unsubscribe(
            message.header_raw("List-Unsubscribe"),
            message.header_raw("List-Unsubscribe-Post"),
        )
    });
    let receipt_to = parsed.as_ref().and_then(receipt_request);
    let (message_id, subject, from, to, cc, date_ts, in_reply_to, references) = match parsed {
        Some(message) => (
            message.message_id().map(clean_message_id),
            message.subject().unwrap_or("").to_string(),
            address_list(message.from()).into_iter().next(),
            address_list(message.to()),
            address_list(message.cc()),
            message.date().map(|d| d.to_timestamp()).or(fallback_date),
            header_message_ids(message.in_reply_to()).into_iter().next(),
            header_message_ids(message.references()),
        ),
        None => (
            None,
            String::new(),
            None,
            Vec::new(),
            Vec::new(),
            fallback_date,
            None,
            Vec::new(),
        ),
    };
    MailMessageCached {
        header: MailMessageHeader {
            account_id: account_id.to_string(),
            folder: folder.to_string(),
            uid,
            message_id,
            subject,
            from,
            to,
            cc,
            date_ts,
            flags,
            has_attachments: false,
            attachment_count: 0,
            attachments: Vec::new(),
            snippet: None,
            raw_size,
            body_cached: false,
            in_reply_to,
            references,
            list_unsubscribe,
            receipt_to,
        },
        body_text: None,
        body_html: None,
        body_cached_at: None,
        internal_ts: fallback_date,
        flags_authoritative: true,
    }
}

/// Message ids of an `In-Reply-To` / `References` header, angle brackets
/// stripped, in header order.
#[cfg(feature = "mime-parse")]
pub fn header_message_ids(value: &mail_parser::HeaderValue<'_>) -> Vec<String> {
    let raw: Vec<String> = match value {
        mail_parser::HeaderValue::Text(text) => vec![text.to_string()],
        mail_parser::HeaderValue::TextList(list) => list.iter().map(|t| t.to_string()).collect(),
        _ => Vec::new(),
    };
    raw.iter()
        .flat_map(|part| {
            part.split_whitespace()
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .map(|id| clean_message_id(&id))
        .filter(|id| !id.is_empty())
        .collect()
}

#[cfg(feature = "mime-parse")]
pub fn parse_body_message(
    account_id: &str,
    folder: &str,
    uid: u32,
    raw_size: Option<u32>,
    body: &[u8],
    max_bytes: usize,
) -> MailMessageCached {
    match MessageParser::default().parse(body) {
        Some(message) => {
            let attachments = message
                .attachments()
                .map(|part| attachment_info(part))
                .collect::<Vec<_>>();
            let text = message
                .body_text(0)
                .map(|s| truncate_utf8_bytes(s.as_ref(), max_bytes));
            let html = message.body_html(0).map(|s| {
                // Thunderbird-style: rewrite embedded cid: images to data: URLs so
                // the reader can show them without a network fetch. Remote http(s)
                // images stay as-is and are gated by the frontend privacy toggle.
                let rewritten = rewrite_cid_images_in_html(&message, s.as_ref());
                let limit = rewritten.len().max(max_bytes).min(MAX_EMBEDDED_BODY_BYTES);
                truncate_utf8_bytes(&rewritten, limit)
            });
            MailMessageCached {
                header: MailMessageHeader {
                    account_id: account_id.to_string(),
                    folder: folder.to_string(),
                    uid,
                    message_id: message.message_id().map(clean_message_id),
                    subject: message.subject().unwrap_or("").to_string(),
                    from: address_list(message.from()).into_iter().next(),
                    to: address_list(message.to()),
                    cc: address_list(message.cc()),
                    date_ts: message.date().map(|d| d.to_timestamp()),
                    flags: Vec::new(),
                    has_attachments: !attachments.is_empty(),
                    attachment_count: attachments.len(),
                    attachments,
                    snippet: message
                        .body_preview(240)
                        .map(|s| normalize_preview(s.as_ref())),
                    raw_size,
                    body_cached: true,
                    in_reply_to: header_message_ids(message.in_reply_to()).into_iter().next(),
                    references: header_message_ids(message.references()),
                    list_unsubscribe: None,
                    receipt_to: receipt_request(&message),
                },
                body_text: text,
                body_html: html,
                body_cached_at: Some(now_ts()),
                internal_ts: None,
                flags_authoritative: false,
            }
        }
        None => {
            let text = truncate_utf8_bytes(&String::from_utf8_lossy(body), max_bytes);
            MailMessageCached {
                header: MailMessageHeader {
                    account_id: account_id.to_string(),
                    folder: folder.to_string(),
                    uid,
                    message_id: None,
                    subject: String::new(),
                    from: None,
                    to: Vec::new(),
                    cc: Vec::new(),
                    date_ts: None,
                    flags: Vec::new(),
                    has_attachments: false,
                    attachment_count: 0,
                    attachments: Vec::new(),
                    snippet: Some(normalize_preview(&text)),
                    raw_size,
                    body_cached: true,
                    in_reply_to: None,
                    references: Vec::new(),
                    list_unsubscribe: None,
                    receipt_to: None,
                },
                body_text: Some(text),
                body_html: None,
                body_cached_at: Some(now_ts()),
                internal_ts: None,
                flags_authoritative: false,
            }
        }
    }
}

/// Receipt address of a read-receipt request (RFC 8098 §2.1).
#[cfg(feature = "mime-parse")]
fn receipt_request(message: &mail_parser::Message<'_>) -> Option<String> {
    let raw = message.header_raw("Disposition-Notification-To")?;
    let address = match (raw.find('<'), raw.rfind('>')) {
        (Some(start), Some(end)) if end > start => &raw[start + 1..end],
        _ => raw,
    };
    let address = address.trim();
    address.contains('@').then(|| address.to_string())
}

pub fn merge_body(target: &mut MailMessageCached, body: MailMessageCached) {
    if target.header.message_id.is_none() {
        target.header.message_id = body.header.message_id;
    }
    if target.header.subject.is_empty() {
        target.header.subject = body.header.subject;
    }
    if target.header.from.is_none() {
        target.header.from = body.header.from;
    }
    if target.header.to.is_empty() {
        target.header.to = body.header.to;
    }
    if target.header.cc.is_empty() {
        target.header.cc = body.header.cc;
    }
    if target.header.date_ts.is_none() {
        target.header.date_ts = body.header.date_ts;
    }
    if target.header.in_reply_to.is_none() {
        target.header.in_reply_to = body.header.in_reply_to;
    }
    if target.header.references.is_empty() {
        target.header.references = body.header.references;
    }
    if target.header.receipt_to.is_none() {
        target.header.receipt_to = body.header.receipt_to.clone();
    }
    if target.header.list_unsubscribe.is_none() {
        target.header.list_unsubscribe = body.header.list_unsubscribe;
    }
    target.header.has_attachments = body.header.has_attachments;
    target.header.attachment_count = body.header.attachment_count;
    target.header.attachments = body.header.attachments;
    target.header.snippet = body.header.snippet;
    target.header.raw_size = body.header.raw_size.or(target.header.raw_size);
    target.header.body_cached = true;
    target.body_text = body.body_text;
    target.body_html = body.body_html;
    target.body_cached_at = body.body_cached_at;
}

pub fn empty_cached_message(account_id: &str, folder: &str, uid: u32) -> MailMessageCached {
    MailMessageCached {
        header: MailMessageHeader {
            account_id: account_id.to_string(),
            folder: folder.to_string(),
            uid,
            message_id: None,
            subject: String::new(),
            from: None,
            to: Vec::new(),
            cc: Vec::new(),
            date_ts: None,
            flags: Vec::new(),
            has_attachments: false,
            attachment_count: 0,
            attachments: Vec::new(),
            snippet: None,
            raw_size: None,
            body_cached: false,
            in_reply_to: None,
            references: Vec::new(),
            list_unsubscribe: None,
            receipt_to: None,
        },
        body_text: None,
        body_html: None,
        body_cached_at: None,
        internal_ts: None,
        flags_authoritative: false,
    }
}

/// `References` header value: ancestry plus the direct parent, de-duplicated,
/// oldest first, each in angle brackets.
pub fn thread_references(references: &[String], in_reply_to: Option<&str>) -> String {
    let mut ids: Vec<String> = Vec::new();
    for id in references.iter().map(String::as_str).chain(in_reply_to) {
        let id = clean_message_id(id);
        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.iter()
        .map(|id| format!("<{id}>"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(feature = "mime-parse")]
fn address_list(addr: Option<&Address<'_>>) -> Vec<MailAddress> {
    addr.map(|addr| {
        addr.iter()
            .map(|item| MailAddress {
                name: item.name.as_ref().map(|v| v.to_string()),
                address: item.address.as_ref().map(|v| v.to_string()),
            })
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(feature = "mime-parse")]
pub fn attachment_info(part: &mail_parser::MessagePart<'_>) -> MailAttachmentInfo {
    let size = match &part.body {
        PartType::Text(s) | PartType::Html(s) => Some(s.len()),
        PartType::Binary(b) | PartType::InlineBinary(b) => Some(b.len()),
        PartType::Message(message) => Some(message.raw_message().len()),
        PartType::Multipart(_) => None,
    };
    let content_type = part.content_type().map(|ct| match ct.c_subtype.as_ref() {
        Some(subtype) => format!("{}/{}", ct.c_type, subtype),
        None => ct.c_type.to_string(),
    });
    MailAttachmentInfo {
        name: part.attachment_name().map(ToOwned::to_owned),
        content_type,
        size,
        section: None,
    }
}

#[cfg(feature = "mime-parse")]
pub fn extract_attachment(
    body: &[u8],
    attachment_index: usize,
) -> Result<DownloadedMailAttachment, String> {
    let message = MessageParser::default()
        .parse(body)
        .ok_or_else(|| "failed to parse message attachments".to_string())?;
    let mut attachments = message.attachments();
    let ordinal = attachment_index.saturating_add(1);
    let part = attachments
        .nth(attachment_index)
        .ok_or_else(|| format!("attachment #{ordinal} not found"))?;
    decoded_attachment(part)
}

/// Resolve IMAP section numbering against the MIME tree, independent of the
/// parser's attachment list (which can order inline/alternative parts differently).
#[cfg(feature = "mime-parse")]
pub fn extract_attachment_section(
    body: &[u8],
    section: &str,
) -> Result<DownloadedMailAttachment, String> {
    fn locate<'a, 'b>(
        message: &'b mail_parser::Message<'a>,
        index: usize,
        path: &[usize],
        root: bool,
    ) -> Option<&'b mail_parser::MessagePart<'a>> {
        let part = message.parts.get(index)?;
        if path.is_empty() {
            return Some(part);
        }
        match &part.body {
            PartType::Multipart(children) => {
                let child = *children.get(path[0].checked_sub(1)?)? as usize;
                locate(message, child, &path[1..], false)
            }
            PartType::Message(nested) => locate(nested, 0, path, true),
            _ if root && path == [1] => Some(part),
            _ => None,
        }
    }
    let path = section
        .split('.')
        .map(str::parse::<usize>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Invalid attachment section".to_string())?;
    let message = MessageParser::default()
        .parse(body)
        .ok_or_else(|| "failed to parse message attachments".to_string())?;
    let part = locate(&message, 0, &path, true)
        .ok_or_else(|| format!("attachment section {section} not found in local original"))?;
    decoded_attachment(part)
}

#[cfg(feature = "mime-parse")]
fn decoded_attachment(
    part: &mail_parser::MessagePart<'_>,
) -> Result<DownloadedMailAttachment, String> {
    let info = attachment_info(part);
    let bytes = match &part.body {
        PartType::Text(s) | PartType::Html(s) => s.as_ref().as_bytes().to_vec(),
        PartType::Binary(b) | PartType::InlineBinary(b) => b.as_ref().to_vec(),
        PartType::Message(message) => message.raw_message().to_vec(),
        PartType::Multipart(_) => {
            return Err("selected attachment is a multipart container".into());
        }
    };
    Ok(DownloadedMailAttachment {
        name: info.name,
        content_type: info.content_type,
        bytes,
    })
}

pub fn clean_message_id(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_string()
}

pub fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(feature = "mime-parse")]
fn normalize_preview(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
