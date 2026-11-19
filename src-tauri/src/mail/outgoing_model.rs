use serde::Deserialize;
use serde::Serialize;

pub use taomni_mail_engine::compose::{MailSendAttachment, MailSendRequest};

/// Queue state of a draft waiting in the local Outbox (TASK-17).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailOutboxState {
    /// Earliest send time (epoch seconds); `None` = wait for "Send now".
    #[serde(default)]
    pub send_at: Option<i64>,
    #[serde(default)]
    pub queued_at: i64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub read_receipt: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendResult {
    pub accepted: bool,
    pub response: String,
    /// Folder that received the copy of the sent message (IMAP APPEND).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_copy_folder: Option<String>,
    /// Why no sent copy was stored, when saving one was attempted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_copy_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftAttachment {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub inline: bool,
    #[serde(default)]
    pub content_id: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftContext {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub uid: Option<u32>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
    /// Thread ancestry of the replied-to message, oldest first.
    #[serde(default)]
    pub references: Vec<String>,
    /// Sending identity chosen in the composer.
    #[serde(default)]
    pub identity_id: Option<String>,
    /// Present while the draft waits in the Outbox.
    #[serde(default)]
    pub outbox: Option<MailOutboxState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraft {
    pub id: String,
    pub account_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text_body: String,
    pub html_body: String,
    pub attachments: Vec<MailDraftAttachment>,
    #[serde(default)]
    pub reply_context: Option<MailDraftContext>,
    #[serde(default)]
    pub remote_draft_folder: Option<String>,
    #[serde(default)]
    pub remote_draft_uid: Option<u32>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftSaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub text_body: String,
    #[serde(default)]
    pub html_body: String,
    #[serde(default)]
    pub attachments: Vec<MailDraftAttachment>,
    #[serde(default)]
    pub reply_context: Option<MailDraftContext>,
    #[serde(default)]
    pub remote_draft_folder: Option<String>,
    #[serde(default)]
    pub remote_draft_uid: Option<u32>,
}
