//! Mail protocol adapters and delivery for the independent Mail host.

pub use taomni_mail_storage::agenda;
pub mod archive;
pub use taomni_mail_storage::attachment_cache;
pub use taomni_mail_storage::cache;
pub use taomni_mail_storage::calendar;
#[cfg(feature = "mime-compose")]
pub use taomni_mail_storage::compose;
pub use taomni_mail_storage::contacts;
pub use taomni_mail_storage::database;
#[cfg(feature = "mime-compose")]
pub mod delivery;
pub use taomni_mail_storage::draft_import;
pub use taomni_mail_storage::drafts;
pub mod filters;
pub mod imap_auth;
pub use taomni_mail_storage::imap_errors;
pub mod imap_folders;
#[cfg(feature = "imap-runtime")]
pub mod imap_idle;
#[cfg(feature = "imap-runtime")]
pub mod imap_messages;
#[cfg(feature = "imap-runtime")]
pub mod imap_mutations;
pub mod imap_outgoing;
pub use taomni_mail_storage::imap_ownership;
#[cfg(feature = "imap-runtime")]
pub mod imap_parts;
pub mod imap_sync;
#[cfg(feature = "imap-runtime")]
pub mod imap_transport;
pub mod mbox;
pub use taomni_mail_storage::migration;
#[cfg(feature = "mime-parse")]
pub use taomni_mail_storage::mime_sections;
pub use taomni_mail_storage::mutation_journal;
#[cfg(feature = "imap-runtime")]
pub mod mutation_transport;
pub mod pop3;
#[cfg(feature = "mime-compose")]
pub mod responses;
pub mod search;
#[cfg(any(feature = "legacy-smtp", feature = "routed-smtp", test))]
pub mod smtp;
pub use taomni_mail_storage::storage;
#[cfg(all(test, feature = "mime-parse"))]
mod tests;
pub mod tls;
pub use taomni_mail_storage::vcard;

pub use taomni_mail_storage::{
    DownloadedMailAttachment, MailAddress, MailAttachmentInfo, MailFolder, MailMessageBody,
    MailMessageCached, MailMessageHeader,
};
#[cfg(feature = "mime-parse")]
pub use taomni_mail_storage::{
    HeaderInput, attachment_info, extract_attachment, extract_attachment_section,
    header_message_ids, parse_body_message, parse_header,
};
pub use taomni_mail_storage::{MailListUnsubscribe, parse_list_unsubscribe};
pub use taomni_mail_storage::{
    clean_message_id, empty_cached_message, merge_body, thread_references, truncate_utf8_bytes,
};

pub use taomni_mail_storage::now_ts;
