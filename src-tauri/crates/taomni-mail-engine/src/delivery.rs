//! Convert a composed message to its transport-independent bytes and envelope.

use lettre::{Message, address::Envelope};
use taomni_mail_api::compose::{ComposeEnvelope, PreparedMail};

pub fn prepare_message(message: Message) -> PreparedMail {
    prepare_with_envelope(message.envelope(), message.formatted())
}

pub(crate) fn prepare_with_envelope(envelope: &Envelope, bytes: Vec<u8>) -> PreparedMail {
    PreparedMail {
        envelope: ComposeEnvelope {
            sender: envelope.from().map(ToString::to_string),
            recipients: envelope.to().iter().map(ToString::to_string).collect(),
        },
        bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_mime_preserves_blind_recipients_in_the_shared_envelope() {
        let smtp = Message::builder()
            .from("sender@example.com".parse().unwrap())
            .to("reader@example.com".parse().unwrap())
            .bcc("blind@example.com".parse().unwrap())
            .subject("Shared envelope")
            .body(String::from("Message body"))
            .unwrap();
        let mime = smtp.formatted();
        let prepared = prepare_message(smtp);
        assert_eq!(prepared.bytes, mime);
        assert!(!String::from_utf8_lossy(&prepared.bytes).contains("blind@example.com"));
        assert_eq!(
            prepared.envelope.sender.as_deref(),
            Some("sender@example.com")
        );
        assert_eq!(
            prepared.envelope.recipients,
            ["reader@example.com", "blind@example.com"]
        );
    }
}
