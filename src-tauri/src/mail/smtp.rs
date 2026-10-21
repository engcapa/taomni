use super::*;

pub(super) struct MailSmtpTransport {
    pub(super) mailer: SmtpTransport,
    pub(super) forward_task: Option<JoinHandle<()>>,
}

impl Drop for MailSmtpTransport {
    fn drop(&mut self) {
        if let Some(task) = self.forward_task.take() {
            task.abort();
        }
    }
}

/// SMTP failure text, with a hint when the server rejected the size (AC-47).
pub(super) fn smtp_send_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    let too_big = lower.contains("552")
        || lower.contains("message size")
        || lower.contains("too large")
        || lower.contains("exceeds") && lower.contains("size");
    if too_big {
        format!(
            "SMTP send failed: the message is larger than this server accepts (SIZE limit). Remove or shrink attachments, or share them as links. Server said: {error}"
        )
    } else {
        certs::certificate_error_hint(&format!("SMTP send failed: {error}"), false)
    }
}

pub(super) fn send_smtp_with(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
    runtime: &tokio::runtime::Handle,
    options: &MessageBuildOptions,
) -> Result<MailSendResult, String> {
    let message = build_send_message_with(account, request, options)?;
    let transport = build_smtp_transport(account, runtime)?;
    let response = transport
        .mailer
        .send(&message)
        .map_err(|e| smtp_send_error(&e.to_string()))?;
    Ok(MailSendResult {
        accepted: true,
        response: format!("{response:?}"),
        sent_copy_folder: None,
        sent_copy_error: None,
    })
}

pub(super) fn test_smtp(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<(), String> {
    let transport = build_smtp_transport(account, runtime)?;
    let connected = transport
        .mailer
        .test_connection()
        .map_err(|e| format!("SMTP test failed: {e}"))?;
    if connected {
        Ok(())
    } else {
        Err("SMTP test did not establish a connection".into())
    }
}

pub(super) fn build_smtp_transport(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<MailSmtpTransport, String> {
    let host = account.config.smtp.host.trim();
    let (connect_host, connect_port, forward_task) =
        mail_effective_endpoint(account, host, account.config.smtp.port, runtime)?;
    let mut builder = SmtpTransport::builder_dangerous(connect_host)
        .port(connect_port)
        .timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
        .credentials(Credentials::new(
            account.smtp_username.clone(),
            account.smtp_password.clone(),
        ));
    if account.auth_mode == MailAuthMode::OAuth2 {
        builder = builder.authentication(vec![Mechanism::Xoauth2]);
    }
    let trusted = account.config.smtp.trusted_cert.as_deref();
    builder = match account.config.smtp.security {
        MailConnectionSecurity::Tls => {
            builder.tls(Tls::Wrapper(certs::smtp_tls_parameters(host, trusted)?))
        }
        MailConnectionSecurity::Starttls => {
            builder.tls(Tls::Required(certs::smtp_tls_parameters(host, trusted)?))
        }
        MailConnectionSecurity::None => builder.tls(Tls::None),
    };
    Ok(MailSmtpTransport {
        mailer: builder.build(),
        forward_task,
    })
}

pub(super) fn build_send_message(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
) -> Result<Message, String> {
    build_send_message_with(account, request, &MessageBuildOptions::default())
}

/// Knobs for the stored copies of a message (Sent copy, server draft).
#[derive(Debug, Default)]
pub(super) struct MessageBuildOptions {
    /// Explicit `Message-ID` (with brackets) so the SMTP message and its
    /// stored copy share one id and the copy can be found again.
    pub message_id: Option<String>,
    /// Keep the `Bcc` header (Sent copies do, like Thunderbird).
    pub keep_bcc: bool,
    /// Drafts may have no recipients: address the envelope to the sender.
    pub self_envelope: bool,
}

pub(super) fn build_send_message_with(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
    options: &MessageBuildOptions,
) -> Result<Message, String> {
    let from = match request
        .from
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(identity) => parse_mailbox(identity)?,
        None => Mailbox::new(
            account.config.display_name.clone().and_then(non_empty),
            account
                .config
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
        .or(account.config.reply_to.as_deref())
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
    let attachments = read_send_attachments(&request.attachments)?;
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

pub(super) struct ResolvedSendAttachment {
    pub(super) name: String,
    pub(super) content_type: ContentType,
    pub(super) bytes: Vec<u8>,
    pub(super) inline: bool,
    pub(super) content_id: Option<String>,
}

pub(super) enum SendBodyPart {
    Single(SinglePart),
    Multi(MultiPart),
}

pub(super) fn build_send_body_part(request: &MailSendRequest) -> Result<SendBodyPart, String> {
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

pub(super) fn add_body_part_to_multipart(multipart: MultiPart, body: SendBodyPart) -> MultiPart {
    match body {
        SendBodyPart::Single(part) => multipart.singlepart(part),
        SendBodyPart::Multi(part) => multipart.multipart(part),
    }
}

pub(super) fn build_related_body<'a>(
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
            Attachment::new_inline_with_name(content_id.to_string(), attachment.name.clone())
                .body(attachment.bytes.clone(), attachment.content_type.clone()),
        );
    }
    Ok(related)
}

pub(super) fn regular_attachment_part(attachment: &ResolvedSendAttachment) -> SinglePart {
    Attachment::new(attachment.name.clone())
        .body(attachment.bytes.clone(), attachment.content_type.clone())
}

pub(super) fn read_send_attachments(
    attachments: &[MailSendAttachment],
) -> Result<Vec<ResolvedSendAttachment>, String> {
    attachments
        .iter()
        .enumerate()
        .map(|(index, attachment)| {
            let raw_path = attachment.path.trim();
            if raw_path.is_empty() {
                return Err(format!("attachment #{} path is required", index + 1));
            }
            let path = Path::new(raw_path);
            let bytes = std::fs::read(path)
                .map_err(|e| format!("failed to read attachment {}: {e}", path.display()))?;
            let name = attachment
                .name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| format!("attachment-{}", index + 1));
            Ok(ResolvedSendAttachment {
                name,
                content_type: attachment_content_type(attachment.content_type.as_deref()),
                bytes,
                inline: attachment.inline,
                content_id: attachment
                    .content_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned),
            })
        })
        .collect()
}

pub(super) fn attachment_content_type(value: Option<&str>) -> ContentType {
    let fallback = "application/octet-stream";
    let candidate = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    ContentType::parse(candidate).unwrap_or_else(|_| {
        ContentType::parse(fallback).expect("application/octet-stream content type is valid")
    })
}

pub(super) fn parse_mailbox(input: &str) -> Result<Mailbox, String> {
    input
        .trim()
        .parse()
        .map_err(|e| format!("invalid email address '{input}': {e}"))
}

pub(super) fn validate_send_request(request: &MailSendRequest) -> Result<(), String> {
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
