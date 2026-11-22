use super::{MailSendAttachment, MailSendRequest, ResolvedMailAccount};
use std::path::Path;

#[cfg(feature = "legacy-mail-smtp")]
use super::{DEFAULT_TIMEOUT_SECS, Duration, ProxyForward, mail_effective_endpoint};

use taomni_mail_engine::compose::{
    MailSender, ResolvedSendAttachment, attachment_content_type, build_message,
};
pub(super) use taomni_mail_engine::compose::{MessageBuildOptions, validate_send_request};

use taomni_mail_engine::delivery::PreparedMail;
#[cfg(feature = "legacy-mail-smtp")]
use taomni_mail_engine::smtp::{SmtpClient, SmtpEndpoint};

#[cfg(feature = "legacy-mail-smtp")]
pub(super) struct MailSmtpTransport {
    pub(super) mailer: SmtpClient,
    _forward: Option<ProxyForward>,
}

#[cfg(feature = "legacy-mail-smtp")]
pub(super) fn test_smtp(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<(), String> {
    let transport = build_smtp_transport(account, runtime)?;
    transport.mailer.test_connection()
}

#[cfg(feature = "legacy-mail-smtp")]
pub(super) fn build_smtp_transport(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<MailSmtpTransport, String> {
    let host = account.config.smtp.host.trim();
    let (connect_host, connect_port, forward) =
        mail_effective_endpoint(account, host, account.config.smtp.port, runtime)?;
    let mailer = SmtpClient::new(SmtpEndpoint {
        connect_host: &connect_host,
        connect_port,
        server_name: host,
        timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        security: account.config.smtp.security,
        trusted_certificate: account.config.smtp.trusted_cert.as_deref(),
        username: &account.smtp_username,
        secret: &account.smtp_password,
        authentication: account.auth_mode,
    })?;
    Ok(MailSmtpTransport {
        mailer,
        _forward: forward,
    })
}

pub(super) fn build_send_message(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
) -> Result<PreparedMail, String> {
    build_send_message_with(account, request, &MessageBuildOptions::default())
}

pub(super) fn build_send_message_with(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
    options: &MessageBuildOptions,
) -> Result<PreparedMail, String> {
    let sender = MailSender {
        email_address: &account.config.email_address,
        display_name: account.config.display_name.as_deref(),
        reply_to: account.config.reply_to.as_deref(),
    };
    build_message(sender, request, options, read_send_attachments).map(PreparedMail::from)
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
