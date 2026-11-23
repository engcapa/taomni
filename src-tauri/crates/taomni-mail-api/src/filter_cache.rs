//! Filter candidates and their mailbox generation at the time of selection.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::message::MailMessageHeader;

pub const IMAP_FILTER_CACHE: &str = "mail/imap-filter-cache";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapFilterCacheRequest {
    pub account_id: String,
    pub database: PathBuf,
    pub action: FilterCacheAction,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum FilterCacheAction {
    Candidates {
        folder: String,
        incoming: bool,
        uids: Option<Vec<u32>>,
    },
    Baseline {
        folder: String,
    },
    Advance {
        folder: String,
        uid: u32,
        uid_validity: Option<u32>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilterCandidates {
    pub uid_validity: Option<u32>,
    pub messages: Vec<(MailMessageHeader, Option<String>)>,
}
