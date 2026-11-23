//! Mail search fields and the native request for one IMAP folder.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSearchField {
    #[default]
    All,
    Subject,
    Sender,
    Recipients,
    Body,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSearchQuery {
    #[serde(default)]
    pub text: String,
    /// `None` searches every cached folder of the account.
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub field: MailSearchField,
    #[serde(default)]
    pub unread_only: bool,
    #[serde(default)]
    pub flagged_only: bool,
    #[serde(default)]
    pub with_attachments: bool,
    /// Only messages carrying this IMAP keyword (tag).
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapSearchRequest {
    pub account_id: String,
    pub folder: String,
    pub query: MailSearchQuery,
}
