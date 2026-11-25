//! Update one account's recipient suggestions after SMTP acceptance.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const RECORD_SENT_CONTACTS: &str = "mail/record-sent-contacts";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SentContactsUpdate {
    pub account_id: String,
    pub database: PathBuf,
    pub recipients: Vec<String>,
}
