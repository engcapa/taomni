use crate::mail::vcard::MailContactCard;
use serde::Deserialize;
use serde::Serialize;

/// CardDAV address book of a mail account (session options).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailCardDavSettings {
    /// Server, principal or address book URL (discovery finds the book).
    pub url: String,
    /// Login when it differs from the IMAP username.
    #[serde(default)]
    pub username: Option<String>,
}

/// One address book entry as the UI edits it (`raw` stays in the backend).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAddressBookEntry {
    #[serde(default)]
    pub uid: String,
    /// `local` or `carddav`.
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
    /// Local change not yet on the CardDAV server.
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

#[derive(Debug, Clone)]
pub(in crate::mail) struct StoredCard {
    pub card: MailContactCard,
    pub book: String,
    pub href: Option<String>,
    pub etag: Option<String>,
    pub dirty: bool,
    pub deleted: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCardDavSyncResult {
    pub collection: String,
    /// Cards added or updated from the server.
    pub pulled: usize,
    /// Local cards removed because the server no longer has them.
    pub removed: usize,
    /// Local changes uploaded (including deletions).
    pub pushed: usize,
    /// Local edits dropped because the server copy changed (server wins).
    pub conflicts: usize,
    pub errors: Vec<String>,
}

pub(in crate::mail) enum CardChange {
    Store(StoredCard),
    Remove(String),
}
