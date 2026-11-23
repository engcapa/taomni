//! MIME message construction for SMTP, Sent copies, and server drafts.

use lettre::Message;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType};
pub use taomni_mail_api::compose::{MailSendAttachment, MailSendRequest, MessageBuildOptions};

use crate::{clean_message_id, thread_references};

pub struct MailSender<'a> {
    pub email_address: &'a str,
    pub display_name: Option<&'a str>,
    pub reply_to: Option<&'a str>,
}

/// `Disposition-Notification-To` (RFC 8098); lettre has no typed header.
#[derive(Debug, Clone)]
struct DispositionNotificationTo(String);

impl lettre::message::header::Header for DispositionNotificationTo {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("Disposition-Notification-To")
    }

    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.trim().to_string()))
    }

    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

pub fn build_message(
    sender: MailSender<'_>,
    request: &MailSendRequest,
    options: &MessageBuildOptions,
    read_attachments: impl FnOnce(&[MailSendAttachment]) -> Result<Vec<ResolvedSendAttachment>, String>,
) -> Result<Message, String> {
    let from = match request
        .from
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(identity) => parse_mailbox(identity)?,
        None => Mailbox::new(
            sender
                .display_name
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned),
            sender
                .email_address
                .parse()
                .map_err(|e| format!("invalid from address: {e}"))?,
        ),
    };
    let from_address = from.email.clone();
    let receipt_address = from_address.to_string();
    let mut builder = Message::builder()
        .from(from)
        .subject(request.subject.trim());
    if let Some(message_id) = &options.message_id {
        builder = builder.message_id(Some(message_id.clone()));
    }
    if options.keep_bcc {
        builder = builder.keep_bcc();
    }
    if options.self_envelope {
        let envelope =
            lettre::address::Envelope::new(Some(from_address.clone()), vec![from_address])
                .map_err(|e| format!("invalid draft envelope: {e}"))?;
        builder = builder.envelope(envelope);
    }
    if let Some(reply_to) = request
        .reply_to
        .as_deref()
        .or(sender.reply_to)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        builder = builder.reply_to(parse_mailbox(reply_to)?);
    }
    for to in &request.to {
        builder = builder.to(parse_mailbox(to)?);
    }
    for cc in &request.cc {
        builder = builder.cc(parse_mailbox(cc)?);
    }
    for bcc in &request.bcc {
        builder = builder.bcc(parse_mailbox(bcc)?);
    }
    if let Some(parent) = request
        .in_reply_to
        .as_deref()
        .map(clean_message_id)
        .filter(|id| !id.is_empty())
    {
        builder = builder.in_reply_to(format!("<{parent}>"));
    }
    let references = thread_references(&request.references, request.in_reply_to.as_deref());
    if !references.is_empty() {
        builder = builder.references(references);
    }
    if request.request_read_receipt {
        // Receipts go to the visible sender (identity), like Thunderbird.
        builder = builder.header(DispositionNotificationTo(format!("<{receipt_address}>")));
    }

    let body = build_send_body_part(request)?;
    let attachments = read_attachments(&request.attachments)?;
    let has_inline = attachments.iter().any(|attachment| attachment.inline);
    let has_regular = attachments.iter().any(|attachment| !attachment.inline);

    if has_inline {
        let related = build_related_body(
            body,
            attachments.iter().filter(|attachment| attachment.inline),
        )?;
        if has_regular {
            let mut mixed = MultiPart::mixed().multipart(related);
            for attachment in attachments.iter().filter(|attachment| !attachment.inline) {
                mixed = mixed.singlepart(regular_attachment_part(attachment));
            }
            builder
                .multipart(mixed)
                .map_err(|e| format!("failed to build email body: {e}"))
        } else {
            builder
                .multipart(related)
                .map_err(|e| format!("failed to build email body: {e}"))
        }
    } else if has_regular {
        let mut mixed = add_body_part_to_multipart(MultiPart::mixed().build(), body);
        for attachment in &attachments {
            mixed = mixed.singlepart(regular_attachment_part(attachment));
        }
        builder
            .multipart(mixed)
            .map_err(|e| format!("failed to build email body: {e}"))
    } else {
        match body {
            SendBodyPart::Single(part) => builder
                .singlepart(part)
                .map_err(|e| format!("failed to build email body: {e}")),
            SendBodyPart::Multi(part) => builder
                .multipart(part)
                .map_err(|e| format!("failed to build email body: {e}")),
        }
    }
}

pub struct ResolvedSendAttachment {
    pub name: String,
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
    pub inline: bool,
    pub content_id: Option<String>,
}

enum SendBodyPart {
    Single(SinglePart),
    Multi(MultiPart),
}

fn build_send_body_part(request: &MailSendRequest) -> Result<SendBodyPart, String> {
    match (&request.text_body, &request.html_body) {
        (Some(text), Some(html)) => Ok(SendBodyPart::Multi(MultiPart::alternative_plain_html(
            text.clone(),
            html.clone(),
        ))),
        (Some(text), None) => Ok(SendBodyPart::Single(SinglePart::plain(text.clone()))),
        (None, Some(html)) => Ok(SendBodyPart::Single(SinglePart::html(html.clone()))),
        (None, None) => Err("email body is required".into()),
    }
}

fn add_body_part_to_multipart(multipart: MultiPart, body: SendBodyPart) -> MultiPart {
    match body {
        SendBodyPart::Single(part) => multipart.singlepart(part),
        SendBodyPart::Multi(part) => multipart.multipart(part),
    }
}

fn build_related_body<'a>(
    body: SendBodyPart,
    inline_attachments: impl Iterator<Item = &'a ResolvedSendAttachment>,
) -> Result<MultiPart, String> {
    let mut related = add_body_part_to_multipart(MultiPart::related().build(), body);
    for attachment in inline_attachments {
        let content_id = attachment.content_id.as_deref().ok_or_else(|| {
            format!(
                "inline attachment {} is missing a Content-ID",
                attachment.name
            )
        })?;
        related = related.singlepart(
            Attachment::new_inline_with_name(content_id.to_string(), attachment.name.clone()).body(
                attachment.bytes.clone(),
                attachment_content_type(attachment.content_type.as_deref()),
            ),
        );
    }
    Ok(related)
}

fn regular_attachment_part(attachment: &ResolvedSendAttachment) -> SinglePart {
    Attachment::new(attachment.name.clone()).body(
        attachment.bytes.clone(),
        attachment_content_type(attachment.content_type.as_deref()),
    )
}

fn attachment_content_type(value: Option<&str>) -> ContentType {
    let fallback = "application/octet-stream";
    let candidate = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    ContentType::parse(candidate).unwrap_or_else(|_| {
        ContentType::parse(fallback).expect("application/octet-stream content type is valid")
    })
}

pub fn parse_mailbox(input: &str) -> Result<Mailbox, String> {
    input
        .trim()
        .parse()
        .map_err(|e| format!("invalid email address '{input}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENDER: MailSender<'_> = MailSender {
        email_address: "sender@example.com",
        display_name: Some(" Sender "),
        reply_to: Some("replies@example.com"),
    };

    fn request(recipient: &str) -> MailSendRequest {
        serde_json::from_value(serde_json::json!({
            "to": [recipient],
            "subject": "Draft",
            "textBody": "Message",
            "attachments": [{"path": "attachment.pdf"}],
        }))
        .unwrap()
    }

    #[test]
    fn invalid_address_does_not_read_attachments() {
        let result = build_message(
            SENDER,
            &request("invalid"),
            &MessageBuildOptions::default(),
            |_| panic!("invalid recipients must be rejected before requesting attachments"),
        );
        assert!(result.unwrap_err().contains("invalid email address"));
    }

    #[test]
    fn builds_a_message_with_attachment_bytes_supplied_by_the_caller() {
        let message = build_message(
            SENDER,
            &request("recipient@example.com"),
            &MessageBuildOptions::default(),
            |attachments| {
                assert_eq!(attachments[0].path, "attachment.pdf");
                Ok(vec![ResolvedSendAttachment {
                    name: "report.pdf".into(),
                    content_type: Some("application/pdf".into()),
                    bytes: b"attachment content".to_vec(),
                    inline: false,
                    content_id: None,
                }])
            },
        )
        .unwrap();
        let wire = String::from_utf8(message.formatted()).unwrap();
        assert!(wire.contains("From: Sender <sender@example.com>"));
        assert!(wire.contains("Reply-To: replies@example.com"));
        assert!(wire.contains("Content-Type: application/pdf"));
        assert!(wire.contains("report.pdf"));
    }
}
