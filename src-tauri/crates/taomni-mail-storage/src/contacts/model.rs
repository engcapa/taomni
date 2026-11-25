use crate::vcard::MailContactCard;
use serde::{Deserialize, Serialize};

/// One address book entry as the UI edits it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAddressBookEntry {
    #[serde(default)]
    pub uid: String,
    /// Local or CardDAV.
    #[serde(default)]
    pub book: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub emails: Vec<String>,
    #[serde(default)]
    pub phones: Vec<String>,
    #[serde(default)]
    pub org: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// Local change pending a CardDAV sync.
    #[serde(default)]
    pub pending_sync: bool,
}

impl MailAddressBookEntry {
    pub(super) fn from_card(card: MailContactCard, book: &str, pending: bool) -> Self {
        Self {
            uid: card.uid,
            book: book.to_string(),
            display_name: card.display_name,
            emails: card.emails,
            phones: card.phones,
            org: card.org,
            note: card.note,
            pending_sync: pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredCard {
    pub card: MailContactCard,
    pub book: String,
    pub href: Option<String>,
    pub etag: Option<String>,
    pub dirty: bool,
    pub deleted: bool,
}

#[derive(Serialize, Deserialize)]
pub enum CardChange {
    Store(StoredCard),
    Remove(String),
}

impl CardChange {
    pub(super) fn uid(&self) -> &str {
        match self {
            Self::Store(card) => &card.card.uid,
            Self::Remove(uid) => uid,
        }
    }
}

#[derive(Debug)]
pub enum ContactWriteError {
    InvalidEntry(String),
    Database(rusqlite::Error),
}

impl std::fmt::Display for ContactWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEntry(message) => formatter.write_str(message),
            Self::Database(error) => error.fmt(formatter),
        }
    }
}

impl From<rusqlite::Error> for ContactWriteError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}
