//! Open a verified original from the account cache selected by the core.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::pop3_store::LocalArchiveAction;

pub const OPEN_ARCHIVE_ORIGINAL: &str = "mail/open-archive-original";
pub const MAX_ARCHIVE_ORIGINAL_REQUEST: u64 = 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveOriginalRequest {
    pub account_id: String,
    pub database: PathBuf,
    pub action: LocalArchiveAction,
}
