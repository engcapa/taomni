//! Mail message data, MIME parsing and archived message codecs.

pub mod archive;
pub mod cache;
pub mod database;
mod inline_images;
mod lists;
mod mime;
mod models;
pub mod storage;
#[cfg(test)]
mod tests;

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
