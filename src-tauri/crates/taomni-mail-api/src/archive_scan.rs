//! Persisted progress and maintenance for an authorized IMAP account cache.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{archive_index::ArchiveKey, imap_sync::FolderStepOutcome};

pub const IMAP_ARCHIVE_SCAN_STATE: &str = "mail/imap-archive-scan-state";
pub const POP3_CLEAR_ERROR: &str =
    "This POP3 account keeps its mail only on this computer; clearing the cache would delete it.";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveScanRequest {
    pub account_id: String,
    pub database: PathBuf,
    pub action: ArchiveScanAction,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ArchiveScanAction {
    Status,
    Pause,
    Begin {
        resume: bool,
    },
    FolderState {
        folder: String,
    },
    CommitHeaders {
        outcome: Box<FolderStepOutcome>,
        body_recent_limit: u32,
        started_at_ms: i64,
    },
    Pending {
        folder: String,
    },
    Skip {
        key: ArchiveKey,
    },
    ClearCache,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveScanStatus {
    pub paused: bool,
    pub shared: bool,
}
