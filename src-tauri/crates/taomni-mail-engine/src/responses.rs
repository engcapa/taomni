//! Assemble iTIP replies and RFC 8098 notifications for the authorized account.

use lettre::{
    Message,
    address::{Address, Envelope},
    message::{Mailbox, MultiPart, SinglePart, header::ContentType},
};
use taomni_mail_api::{
    compose::PreparedMail,
    responses::{MailResponse, Receipt, ResponseRequest},
};

use crate::{
    calendar::{MailInvite, build_reply_ics, partstat_of},
    compose::parse_mailbox,
    delivery::{prepare_message, prepare_with_envelope},
};

pub fn prepare_response(request: &ResponseRequest) -> Result<PreparedMail, String> {
    let me = request.email_address.trim();
    let name = request.display_name.as_deref();
    match &request.response {
        MailResponse::Invitation { invite, response } => {
            invitation(invite, partstat_of(response)?, me, name, request.stamp)
        }
        MailResponse::Receipt(receipt) => {
            let recipient = &receipt.recipient;
            let from: Address = me
                .parse()
                .map_err(|e| format!("invalid account address: {e}"))?;
            let to: Address = recipient
                .parse()
                .map_err(|e| format!("invalid receipt address {recipient}: {e}"))?;
            let envelope = Envelope::new(Some(from), vec![to]).map_err(|e| e.to_string())?;
            let bytes = build_mdn(
                me,
                name,
                recipient,
                receipt,
                receipt.automatic,
                request.stamp,
            )
            .into_bytes();
            Ok(prepare_with_envelope(&envelope, bytes))
        }
    }
}

fn invitation(
    invite: &MailInvite,
    partstat: &str,
    me: &str,
    my_name: Option<&str>,
    stamp: i64,
) -> Result<PreparedMail, String> {
    if invite.method != "REQUEST" {
        return Err(format!("cannot respond to a {} message", invite.method));
    }
    let organizer = invite
        .organizer
        .as_ref()
        .ok_or_else(|| "the invitation has no organizer".to_string())?;
    let ics = build_reply_ics(invite, me, my_name, partstat, stamp);
    let verb = match partstat {
        "ACCEPTED" => "Accepted",
        "TENTATIVE" => "Tentative",
        _ => "Declined",
    };
    let subject = format!("{verb}: {}", invite.summary);
    let from = Mailbox::new(
        my_name.map(str::to_owned),
        me.parse()
            .map_err(|e| format!("invalid from address: {e}"))?,
    );
    let to = parse_mailbox(&organizer.email)?;
    let text = format!(
        "{} has {} this invitation.",
        my_name.unwrap_or(me),
        verb.to_lowercase()
    );
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(text))
                .singlepart(
                    SinglePart::builder()
                        .header(
                            ContentType::parse("text/calendar; method=REPLY; charset=UTF-8")
                                .map_err(|e| format!("calendar content type: {e}"))?,
                        )
                        .body(ics),
                ),
        )
        .map_err(|e| format!("failed to build invitation reply: {e}"))?;
    Ok(prepare_message(message))
}

fn header_safe(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

/// Raw RFC 5322 bytes of a disposition notification for `original`.
fn build_mdn(
    me: &str,
    my_name: Option<&str>,
    receipt_to: &str,
    original: &Receipt,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invitation_response_has_the_requested_attendee_state_and_organizer_envelope() {
        use crate::calendar::MailInviteAttendee;
        let mut invite = MailInvite {
            method: "REQUEST".into(),
            organizer: Some(MailInviteAttendee {
                email: "chair@example.com".into(),
                ..Default::default()
            }),
            uid: "event-1".into(),
            sequence: 3,
            summary: "Review".into(),
            ..Default::default()
        };
        for (action, expected) in [
            ("accept", "ACCEPTED"),
            ("decline", "DECLINED"),
            ("tentative", "TENTATIVE"),
        ] {
            let request = ResponseRequest {
                email_address: "reader@example.com".into(),
                display_name: Some("Reader".into()),
                stamp: 1_700_000_000,
                response: MailResponse::Invitation {
                    invite: Box::new(invite.clone()),
                    response: action.into(),
                },
            };
            let bytes = serde_json::to_vec(&request).unwrap();
            let decoded: ResponseRequest = serde_json::from_slice(&bytes).unwrap();
            let message = prepare_response(&decoded).unwrap();
            assert_eq!(
                message.envelope.sender.as_deref(),
                Some("reader@example.com")
            );
            assert_eq!(message.envelope.recipients, ["chair@example.com"]);
            #[cfg(feature = "mime-parse")]
            {
                let parsed = mail_parser::MessageParser::default()
                    .parse(&message.bytes)
                    .unwrap();
                use mail_parser::MimeHeaders;
                let calendar = parsed
                    .parts
                    .iter()
                    .find(|part| {
                        part.content_type().is_some_and(|kind| {
                            kind.ctype() == "text" && kind.subtype() == Some("calendar")
                        })
                    })
                    .unwrap();
                let ics = std::str::from_utf8(calendar.contents()).unwrap();
                for line in [
                    "METHOD:REPLY",
                    "UID:event-1",
                    "SEQUENCE:3",
                    &format!(
                        "ATTENDEE;PARTSTAT={expected};CN=\"Reader\":mailto:reader@example.com"
                    ),
                ] {
                    assert!(ics.contains(line), "{line}");
                }
            }
        }
        invite.method = "CANCEL".into();
        assert!(invitation(&invite, "ACCEPTED", "reader@example.com", None, 0).is_err());
    }

    #[test]
    fn mdn_follows_rfc_8098() {
        let header = Receipt {
            uid: 7,
            message_id: Some("orig@example.com".into()),
            subject: "Quarterly\r\nnumbers".into(),
            recipient: "boss@example.com".into(),
            automatic: false,
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
        #[cfg(feature = "mime-parse")]
        {
            let parsed = mail_parser::MessageParser::default()
                .parse(raw.as_bytes())
                .unwrap();
            assert_eq!(parsed.parts.len(), 3, "multipart + two parts");
        }
        let auto = build_mdn("me@example.com", None, "boss@example.com", &header, true, 1);
        assert!(auto.contains("automatic-action/MDN-sent-automatically"));
        assert!(auto.contains("From: me@example.com\r\n"));
    }
}
