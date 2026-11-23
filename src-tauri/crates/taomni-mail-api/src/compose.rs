//! Requests to assemble RFC 5322 bytes in the signed Mail host.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendRequest {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    #[serde(default)]
    pub text_body: Option<String>,
    #[serde(default)]
    pub html_body: Option<String>,
    #[serde(default)]
    pub attachments: Vec<MailSendAttachment>,
    /// Message id this message replies to (brackets optional).
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// Thread ancestry, oldest first (brackets optional).
    #[serde(default)]
    pub references: Vec<String>,
    /// Local draft whose server copy should be removed after a successful send.
    #[serde(default)]
    pub draft_id: Option<String>,
    /// `From:` of a non-default identity ("Name <addr>").
    #[serde(default)]
    pub from: Option<String>,
    /// Reply-To of that identity.
    #[serde(default)]
    pub reply_to: Option<String>,
    /// Ask for a read receipt (RFC 8098 `Disposition-Notification-To`).
    #[serde(default)]
    pub request_read_receipt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendAttachment {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub inline: bool,
    #[serde(default)]
    pub content_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageBuildOptions {
    /// Preserve the same Message-ID for an SMTP message and its stored copy.
    pub message_id: Option<String>,
    pub keep_bcc: bool,
    /// Drafts can have no recipients. Address the envelope to the sender.
    pub self_envelope: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposeRequest {
    pub email_address: String,
    pub display_name: Option<String>,
    pub reply_to: Option<String>,
    /// Attachment paths are removed before the request is sent.
    pub message: MailSendRequest,
    pub options: MessageBuildOptions,
    /// Contents follow in frames in this order.
    pub attachments: Vec<ComposeAttachment>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposeAttachment {
    pub name: String,
    pub content_type: Option<String>,
    pub inline: bool,
    pub content_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposeEnvelope {
    pub sender: Option<String>,
    pub recipients: Vec<String>,
}

/// Prepared RFC 5322 bytes paired with the envelope provided by the composer.
pub struct PreparedMail {
    pub envelope: ComposeEnvelope,
    pub bytes: Vec<u8>,
}

pub fn validate_send_request(request: &MailSendRequest) -> Result<(), String> {
    if request.to.is_empty() && request.cc.is_empty() && request.bcc.is_empty() {
        return Err("at least one recipient is required".into());
    }
    if request.subject.trim().is_empty() {
        return Err("email subject is required".into());
    }
    if request
        .text_body
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
        && request
            .html_body
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err("email body is required".into());
    }
    for (index, attachment) in request.attachments.iter().enumerate() {
        if attachment.path.trim().is_empty() {
            return Err(format!("attachment #{} path is required", index + 1));
        }
        if attachment.inline {
            let content_id = attachment
                .content_id
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            if content_id.is_empty() {
                return Err(format!(
                    "inline attachment #{} Content-ID is required",
                    index + 1
                ));
            }
            if content_id
                .chars()
                .any(|ch| matches!(ch, '<' | '>' | '\r' | '\n' | '\0'))
            {
                return Err(format!(
                    "inline attachment #{} Content-ID contains invalid characters",
                    index + 1
                ));
            }
            let content_type = attachment
                .content_type
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            if !content_type
                .get(..content_type.len().min(6))
                .unwrap_or("")
                .eq_ignore_ascii_case("image/")
            {
                return Err(format!(
                    "inline attachment #{} must have an image/* content type",
                    index + 1
                ));
            }
        }
    }
    Ok(())
}
