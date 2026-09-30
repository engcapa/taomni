//! Read receipts we send back (TASK-17): RFC 8098 Message Disposition
//! Notifications, and the RFC 3503 `$MDNSent` keyword so a request is
//! answered (or declined) only once, from any client.

use lettre::Transport;
use lettre::address::{Address, Envelope};
use serde::Serialize;
use tauri::State;

use super::{
    MailAccountConfig, MailMessageHeader, build_smtp_transport, now_ts, resolve_config,
    smtp_send_error, with_mail_db,
};
use crate::state::AppState;

/// IMAP keyword marking "receipt handled" (sent or declined).
pub const MDN_SENT: &str = "$MDNSent";

fn header_safe(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

/// Raw RFC 5322 bytes of a disposition notification for `original`.
pub(super) fn build_mdn(
    me: &str,
    my_name: Option<&str>,
    receipt_to: &str,
    original: &MailMessageHeader,
    automatic: bool,
    now: i64,
) -> String {
    let date = chrono::DateTime::from_timestamp(now, 0)
        .unwrap_or_default()
        .to_rfc2822();
    let boundary = format!("mdn-{now}-{}", original.uid);
    let domain = me.rsplit_once('@').map_or("localhost", |(_, d)| d);
    let from = match my_name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => format!("\"{}\" <{me}>", header_safe(name).replace('"', "'")),
        None => me.to_string(),
    };
    let subject = header_safe(&original.subject);
    let disposition = if automatic {
        "automatic-action/MDN-sent-automatically; displayed"
    } else {
        "manual-action/MDN-sent-manually; displayed"
    };
    let original_id = original
        .message_id
        .as_deref()
        .map(|id| {
            format!(
                "Original-Message-ID: <{}>\r\n",
                header_safe(id.trim_matches(['<', '>']))
            )
        })
        .unwrap_or_default();
    let human = format!(
        "This is a read receipt for the message \"{subject}\" sent to {me}.\r\n\
         It means the message was displayed; it does not mean it was read or understood.\r\n"
    );
    format!(
        "From: {from}\r\nTo: <{}>\r\nSubject: Read: {subject}\r\nDate: {date}\r\n\
         Message-ID: <mdn.{now}.{uid}@{domain}>\r\nMIME-Version: 1.0\r\n\
         Content-Type: multipart/report; report-type=disposition-notification; boundary=\"{boundary}\"\r\n\r\n\
         --{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{human}\r\n\
         --{boundary}\r\nContent-Type: message/disposition-notification\r\n\r\n\
         Reporting-UA: Taomni; Taomni Mail\r\nFinal-Recipient: rfc822;{me}\r\n{original_id}\
         Disposition: {disposition}\r\n\r\n--{boundary}--\r\n",
        header_safe(receipt_to),
        uid = original.uid,
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailReceiptResult {
    pub sent_to: String,
}

/// Send the read receipt the sender of `uid` asked for, then mark it
/// `$MDNSent` (`automatic` = sent by the "always" policy, not a click).
#[tauri::command]
pub async fn mail_send_receipt(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    automatic: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailReceiptResult, String> {
    let folder = folder.trim().to_string();
    let account_id = config.session_id.clone();
    let header = with_mail_db(&state, &account_id, |db| {
        super::cached_header(db, &account_id, &folder, uid)
    })?
    .ok_or_else(|| "the message is not in the local cache".to_string())?;
    let receipt_to = header
        .receipt_to
        .clone()
        .ok_or_else(|| "the sender did not ask for a read receipt".to_string())?;
    if header
        .flags
        .iter()
        .any(|f| f.eq_ignore_ascii_case(MDN_SENT))
    {
        return Err("a read receipt was already handled for this message".into());
    }
    let account = resolve_config(&state, config.clone())?;
    let me = account.config.email_address.trim().to_string();
    let raw = build_mdn(
        &me,
        account.config.display_name.as_deref(),
        &receipt_to,
        &header,
        automatic.unwrap_or(false),
        now_ts(),
    );
    let from: Address = me
        .parse()
        .map_err(|e| format!("invalid account address: {e}"))?;
    let to: Address = receipt_to
        .parse()
        .map_err(|e| format!("invalid receipt address {receipt_to}: {e}"))?;
    let envelope = Envelope::new(Some(from), vec![to]).map_err(|e| e.to_string())?;
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let transport = build_smtp_transport(&account, &handle)?;
        transport
            .mailer
            .send_raw(&envelope, raw.as_bytes())
            .map(|_| ())
            .map_err(|e| smtp_send_error(&e.to_string()))
    })
    .await
    .map_err(|e| format!("read receipt task failed: {e}"))??;
    super::mail_set_flags(
        config,
        folder,
        vec![uid],
        Some(vec![MDN_SENT.into()]),
        None,
        state,
    )
    .await?;
    Ok(MailReceiptResult {
        sent_to: receipt_to,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mdn_follows_rfc_8098() {
        let header = MailMessageHeader {
            account_id: "a".into(),
            folder: "INBOX".into(),
            uid: 7,
            message_id: Some("orig@example.com".into()),
            subject: "Quarterly\r\nnumbers".into(),
            from: None,
            to: Vec::new(),
            cc: Vec::new(),
            date_ts: None,
            flags: Vec::new(),
            has_attachments: false,
            attachment_count: 0,
            attachments: Vec::new(),
            snippet: None,
            raw_size: None,
            body_cached: false,
            in_reply_to: None,
            references: Vec::new(),
            list_unsubscribe: None,
            receipt_to: Some("boss@example.com".into()),
        };
        let raw = build_mdn(
            "me@example.com",
            Some("Me"),
            "boss@example.com",
            &header,
            false,
            1_700_000_000,
        );
        assert!(
            raw.contains("Content-Type: multipart/report; report-type=disposition-notification;")
        );
        assert!(
            raw.contains("Subject: Read: Quarterly  numbers\r\n"),
            "no header injection"
        );
        assert!(raw.contains("To: <boss@example.com>\r\n"));
        assert!(raw.contains("Final-Recipient: rfc822;me@example.com\r\n"));
        assert!(raw.contains("Original-Message-ID: <orig@example.com>\r\n"));
        assert!(raw.contains("Disposition: manual-action/MDN-sent-manually; displayed\r\n"));
        let parsed = mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .unwrap();
        assert_eq!(parsed.parts.len(), 3, "multipart + two parts");
        let auto = build_mdn("me@example.com", None, "boss@example.com", &header, true, 1);
        assert!(auto.contains("automatic-action/MDN-sent-automatically"));
        assert!(auto.contains("From: me@example.com\r\n"));
    }
}
