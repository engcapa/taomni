use super::*;

use taomni_mail_engine::compose::{
    MailSender, ResolvedSendAttachment, attachment_content_type, build_message,
};
pub(super) use taomni_mail_engine::compose::{
    MessageBuildOptions, parse_mailbox, validate_send_request,
};

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

pub(super) fn build_send_message_with(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
    options: &MessageBuildOptions,
) -> Result<Message, String> {
    let sender = MailSender {
        email_address: &account.config.email_address,
        display_name: account.config.display_name.as_deref(),
        reply_to: account.config.reply_to.as_deref(),
    };
    build_message(sender, request, options, read_send_attachments)
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
