//! Publish confirmed IMAP flag changes to the authorized cached mailbox.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::ImapFlagUpdate;

pub const PUBLISH_IMAP_FLAG_CACHE: &str = "mail/publish-imap-flag-cache";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapFlagPublication {
    pub account_id: String,
    pub database: PathBuf,
    pub action: ImapFlagCacheAction,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ImapFlagCacheAction {
    Update {
        flags: ImapFlagUpdate,
    },
    Read {
        folder: String,
        uids: Vec<u32>,
        remaining: Option<usize>,
    },
}
