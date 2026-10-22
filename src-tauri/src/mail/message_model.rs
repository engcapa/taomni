use crate::mail::lists;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAddress {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachmentInfo {
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: Option<usize>,
    /// IMAP section ("2", "1.3") for large messages listed via BODYSTRUCTURE;
    /// downloads then fetch only that part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolder {
    pub account_id: String,
    pub name: String,
    pub display_name: String,
    pub delimiter: Option<String>,
    pub flags: Vec<String>,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub total: Option<u32>,
    pub unread: Option<u32>,
    pub updated_at: i64,
    /// Lowest UID of the contiguous cached span (see `sync.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_low_uid: Option<u32>,
    /// Highest UID of the contiguous cached span.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_high_uid: Option<u32>,
    /// True once the cached span reaches the oldest server message (or the
    /// configured retention boundary), so no older backfill remains.
    #[serde(default)]
    pub sync_complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_count: Option<u32>,
    /// Last sync error for this folder; cleared by the next successful sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageHeader {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: String,
    pub from: Option<MailAddress>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub date_ts: Option<i64>,
    pub flags: Vec<String>,
    pub has_attachments: bool,
    pub attachment_count: usize,
    pub attachments: Vec<MailAttachmentInfo>,
    pub snippet: Option<String>,
    pub raw_size: Option<u32>,
    pub body_cached: bool,
    /// `In-Reply-To` message id (without angle brackets).
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// `References` message ids, oldest first (without angle brackets).
    #[serde(default)]
    pub references: Vec<String>,
    /// `List-Unsubscribe` of mailing-list mail (TASK-18).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_unsubscribe: Option<lists::MailListUnsubscribe>,
    /// `Disposition-Notification-To` address: the sender asked for a read
    /// receipt (RFC 8098, TASK-17).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageBody {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub snippet: Option<String>,
    pub attachments: Vec<MailAttachmentInfo>,
    pub raw_size: Option<u32>,
    pub cached_at: Option<i64>,
    pub source: String,
}

#[derive(Debug, Clone)]
pub(super) struct MailMessageCached {
    pub(super) header: MailMessageHeader,
    pub(super) body_text: Option<String>,
    pub(super) body_html: Option<String>,
    pub(super) body_cached_at: Option<i64>,
    /// Server arrival time (IMAP INTERNALDATE); drives retention pruning.
    pub(super) internal_ts: Option<i64>,
    /// True when `header.flags` came from a FETCH FLAGS response, so an empty
    /// list really means "no flags" (unread) and must overwrite cached flags.
    pub(super) flags_authoritative: bool,
}

#[derive(Debug)]
pub(super) struct DownloadedMailAttachment {
    pub(super) name: Option<String>,
    pub(super) content_type: Option<String>,
    pub(super) bytes: Vec<u8>,
}
