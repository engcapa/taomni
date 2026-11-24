//! Mail message data, MIME parsing and archived message codecs.

pub mod agenda;
pub mod archive;
pub mod attachment_cache;
pub mod cache;
pub mod calendar;
#[cfg(feature = "mime-compose")]
pub mod compose;
pub mod contacts;
pub mod database;
#[cfg(feature = "mime-compose")]
pub mod delivery;
pub mod draft_import;
pub mod drafts;
pub mod filters;
pub mod imap_auth;
pub mod imap_errors;
pub mod imap_folders;
#[cfg(feature = "imap-runtime")]
pub mod imap_idle;
#[cfg(feature = "imap-runtime")]
pub mod imap_messages;
#[cfg(feature = "imap-runtime")]
pub mod imap_mutations;
pub mod imap_outgoing;
pub mod imap_ownership;
#[cfg(feature = "imap-runtime")]
pub mod imap_parts;
pub mod imap_sync;
#[cfg(feature = "imap-runtime")]
pub mod imap_transport;
#[cfg(feature = "mime-parse")]
mod inline_images;
mod lists;
pub mod mbox;
pub mod migration;
mod mime;
#[cfg(feature = "mime-parse")]
pub mod mime_sections;
mod models;
pub mod mutation_journal;
#[cfg(feature = "imap-runtime")]
pub mod mutation_transport;
pub mod pop3;
#[cfg(feature = "mime-compose")]
pub mod responses;
pub mod search;
#[cfg(any(feature = "legacy-smtp", feature = "routed-smtp", test))]
pub mod smtp;
pub mod storage;
#[cfg(all(test, feature = "mime-parse"))]
mod tests;
pub mod tls;
pub mod vcard;

pub use lists::{MailListUnsubscribe, parse_list_unsubscribe};
#[cfg(feature = "mime-parse")]
pub use mime::{
    HeaderInput, attachment_info, extract_attachment, extract_attachment_section,
    header_message_ids, parse_body_message, parse_header,
};
pub use mime::{
    clean_message_id, empty_cached_message, merge_body, thread_references, truncate_utf8_bytes,
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
