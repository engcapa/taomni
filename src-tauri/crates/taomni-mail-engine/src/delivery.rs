//! A complete SMTP envelope travels with its RFC 5322 bytes, including blind recipients.

use lettre::{Message, address::Envelope};
use taomni_mail_api::compose::ComposeEnvelope;

pub struct PreparedMail {
    pub(crate) envelope: Envelope,
    pub bytes: Vec<u8>,
}

impl From<Message> for PreparedMail {
    fn from(message: Message) -> Self {
        Self {
            envelope: message.envelope().clone(),
            bytes: message.formatted(),
        }
    }
}

impl PreparedMail {
    pub fn from_parts(addresses: ComposeEnvelope, bytes: Vec<u8>) -> Result<Self, String> {
        let sender = addresses
            .sender
            .map(|address| address.parse())
            .transpose()
            .map_err(|error| format!("Invalid Mail envelope sender: {error}"))?;
        let recipients = addresses
            .recipients
            .into_iter()
            .map(|address| address.parse())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Invalid Mail envelope recipient: {error}"))?;
        let envelope = Envelope::new(sender, recipients).map_err(|error| error.to_string())?;
        Ok(Self { envelope, bytes })
    }

    pub fn sender(&self) -> Option<String> {
        self.envelope.from().map(ToString::to_string)
    }

    pub fn recipients(&self) -> Vec<String> {
        self.envelope.to().iter().map(ToString::to_string).collect()
    }
}
