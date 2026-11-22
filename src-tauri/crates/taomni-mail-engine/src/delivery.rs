//! A complete SMTP envelope travels with its RFC 5322 bytes, including blind recipients.

use lettre::{Message, address::Envelope};

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
    pub fn sender(&self) -> Option<String> {
        self.envelope.from().map(ToString::to_string)
    }

    pub fn recipients(&self) -> Vec<String> {
        self.envelope.to().iter().map(ToString::to_string).collect()
    }
}
