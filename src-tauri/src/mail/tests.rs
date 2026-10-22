use super::*;

fn sample_message() -> Vec<u8> {
    b"From: Example Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nDate: Tue, 30 Jun 2026 08:00:00 +0800\r\nMessage-ID: <sample@example.com>\r\nSubject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from Taomni Mail.\r\n"
            .to_vec()
}

fn sample_attachment_message() -> Vec<u8> {
    b"From: Example Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nSubject: Attachment sample\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody text.\r\n--b\r\nContent-Type: text/plain; name=\"report.txt\"\r\nContent-Disposition: attachment; filename=\"report.txt\"\r\n\r\nAttachment content.\r\n--b--\r\n"
            .to_vec()
}

fn sample_inline_image_message() -> Vec<u8> {
    // 1x1 PNG (68 bytes raw) base64-encoded for a multipart/related sample.
    b"From: Example Sender <sender@example.com>\r\n\
To: Receiver <receiver@example.com>\r\n\
Subject: Inline image sample\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"rel\"\r\n\
\r\n\
--rel\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Logo: <img src=\"cid:logo@inline.local\" alt=\"logo\"></p>\r\n\
--rel\r\n\
Content-Type: image/png; name=\"logo.png\"\r\n\
Content-Transfer-Encoding: base64\r\n\
Content-ID: <logo@inline.local>\r\n\
Content-Disposition: inline; filename=\"logo.png\"\r\n\
\r\n\
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==\r\n\
--rel--\r\n"
            .to_vec()
}

fn sample_resolved_account() -> ResolvedMailAccount {
    ResolvedMailAccount {
        config: MailAccountConfig {
            session_id: "acct".into(),
            email_address: "sender@example.com".into(),
            provider: MailProvider::Custom,
            auth_mode: MailAuthMode::Password,
            display_name: Some("Sender".into()),
            reply_to: None,
            signature: None,
            imap: MailServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                username: Some("sender@example.com".into()),
                password: Some("secret".into()),
                security: MailConnectionSecurity::Tls,
                trusted_cert: None,
            },
            smtp: MailSmtpConfig {
                host: "smtp.example.com".into(),
                port: 465,
                username: Some("sender@example.com".into()),
                password: Some("secret".into()),
                security: MailConnectionSecurity::Tls,
                use_imap_auth: true,
                trusted_cert: None,
            },
            oauth: MailOAuthSettings::default(),
            network_settings: None,
            sync: MailSyncSettings::default(),
            cache: MailCacheSettings::default(),
            ai: MailAiSettings::default(),
            save_sent_copy: None,
            special_folders: HashMap::new(),
            incoming: MailIncomingProtocol::Imap,
            pop3_leave_days: None,
            carddav: None,
            caldav: None,
        },
        auth_mode: MailAuthMode::Password,
        network_settings: None,
        imap_username: "sender@example.com".into(),
        imap_password: "secret".into(),
        smtp_username: "sender@example.com".into(),
        smtp_password: "secret".into(),
    }
}

mod accounts_and_authentication;
mod compose_and_drafts;
mod live_oauth;
mod parsing_and_cache;
