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
