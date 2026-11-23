//! Index and query an account's mailbox-derived recipient suggestions.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const CONTACT_HISTORY: &str = "mail/contact-history";
pub const MAX_CONTACT_SUGGESTIONS: u32 = 20;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailContactSuggestion {
    pub name: Option<String>,
    pub email: String,
    pub source: String,
    pub score: i64,
    pub last_seen_at: Option<i64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum ContactHistoryAction {
    Reindex,
    Search { query: String, limit: u32 },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContactHistoryRequest {
    pub account_id: String,
    pub database: PathBuf,
    pub action: ContactHistoryAction,
}
