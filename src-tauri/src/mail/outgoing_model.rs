use serde::Serialize;

pub use taomni_mail_api::compose::{MailSendAttachment, MailSendRequest};
pub use taomni_mail_engine::drafts::{
    MailDraft, MailDraftAttachment, MailDraftContext, MailDraftSaveRequest, MailOutboxState,
};

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
