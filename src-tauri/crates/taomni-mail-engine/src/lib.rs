//! Mail message data, MIME parsing and archived message codecs.

pub mod archive;
pub mod attachment_cache;
pub mod cache;
pub mod calendar;
pub mod compose;
pub mod contacts;
pub mod database;
pub mod delivery;
pub mod draft_import;
pub mod drafts;
pub mod filters;
pub mod imap_auth;
pub mod imap_folders;
pub mod imap_messages;
pub mod imap_mutations;
pub mod imap_outgoing;
pub mod imap_parts;
pub mod imap_sync;
pub mod imap_transport;
mod inline_images;
mod lists;
pub mod mbox;
pub mod migration;
mod mime;
pub mod mime_sections;
mod models;
pub mod pop3;
pub mod responses;
pub mod search;
pub mod smtp;
pub mod storage;
#[cfg(test)]
mod tests;
pub mod tls;
pub mod vcard;

pub use lists::{MailListUnsubscribe, parse_list_unsubscribe};
pub use mime::{
    HeaderInput, attachment_info, clean_message_id, empty_cached_message, extract_attachment,
    extract_attachment_section, header_message_ids, merge_body, parse_body_message, parse_header,
    thread_references, truncate_utf8_bytes,
};
pub use models::{
    DownloadedMailAttachment, MailAddress, MailAttachmentInfo, MailFolder, MailMessageBody,
    MailMessageCached, MailMessageHeader,
};

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
