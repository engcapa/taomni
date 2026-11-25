//! Publish a decoded IMAP body in the selected account cache.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const PUBLISH_IMAP_BODY_CACHE: &str = "mail/publish-imap-body-cache";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapBodyPublication<M> {
    pub database: PathBuf,
    pub account_id: String,
    pub observed_at: i64,
    pub source: ImapBodyCacheSource,
    pub message: M,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ImapBodyCacheSource {
    Opened,
    Prefetched { uid_validity: Option<u32> },
}
