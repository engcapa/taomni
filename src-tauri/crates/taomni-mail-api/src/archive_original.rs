//! Open a verified original from the account cache selected by the core.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::pop3_store::LocalArchiveAction;

pub const OPEN_ARCHIVE_ORIGINAL: &str = "mail/open-archive-original";
pub const READ_IMAP_ARCHIVE: &str = "mail/read-imap-archive";
pub const MAX_ARCHIVE_ORIGINAL_REQUEST: u64 = 1024 * 1024;
pub const MAX_ARCHIVE_READER_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveOriginalRequest {
    pub account_id: String,
    pub database: PathBuf,
    pub action: LocalArchiveAction,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapArchiveRequest {
    pub account_id: String,
    pub database: PathBuf,
    pub folder: String,
    pub uid: u32,
    pub action: ImapArchiveAction,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ImapArchiveAction {
    ViewSource,
    SaveOriginal,
    Attachment {
        index: usize,
        section: Option<String>,
    },
}
