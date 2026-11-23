//! Commit a completed IMAP synchronization to the authorized account cache.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{
    imap_sync::FolderStepOutcome,
    message::{MailFolder, MailMessageCached},
};

pub const PUBLISH_IMAP_INDEX: &str = "mail/publish-imap-index";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapIndexPublication<A> {
    pub account_id: String,
    pub database: PathBuf,
    pub retention: ImapIndexRetention,
    pub started_at_ms: i64,
    pub action: A,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapIndexRetention {
    pub header_retention_days: u32,
    pub header_limit_per_folder: u32,
    pub body_recent_limit: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ImapIndexAction {
    Page {
        folders: Vec<MailFolder>,
        messages: Vec<MailMessageCached>,
        selected: String,
        listed: bool,
    },
    Step {
        outcome: FolderStepOutcome,
    },
    Round {
        folder: MailFolder,
        steps: Vec<FolderStepOutcome>,
        error: Option<String>,
    },
    Failure {
        folder: String,
        error: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedStep {
    pub flags_updated: usize,
    pub folder: Option<MailFolder>,
}
