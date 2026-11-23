//! Requests and receipts for native IMAP header and body synchronization.

use serde::{Deserialize, Serialize};

use crate::message::{MailFolder, MailMessageCached, MailMessageHeader};

/// Which work a `mail_sync_folder` call should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSyncRequestMode {
    /// Initialise / repair / fetch new mail, whichever the stored state needs.
    #[default]
    Auto,
    Catchup,
    /// Fetch the next block of older history below `sync_low_uid`.
    Backfill,
    /// Reconcile deletions and flags for the newest cached window.
    Reconcile,
    /// Reconcile deletions and flags for the whole cached span.
    ReconcileFull,
}

/// The work a step actually performed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSyncMode {
    Initial,
    Repair,
    Catchup,
    Backfill,
    Reconcile,
    ReconcileFull,
    /// Cache disabled: a stateless newest page was fetched.
    Uncached,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolderSyncResult {
    pub account_id: String,
    pub folder: MailFolder,
    pub mode: MailSyncMode,
    /// Headers fetched by this step (newest first).
    pub messages: Vec<MailMessageHeader>,
    pub fetched: usize,
    /// Newly arrived messages without `\Seen` (never counts initial sync,
    /// repair of an old gap or history backfill).
    pub new_unseen: usize,
    pub vanished: usize,
    pub flags_updated: usize,
    /// Messages still missing in the planned range after this step.
    pub remaining_new: usize,
    /// True when the caller should call again to finish the requested work.
    pub more: bool,
    pub sync_complete: bool,
    pub uid_validity_reset: bool,
    pub synced_at: i64,
}

/// Persisted per-folder sync state plus the cached UID set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderSyncState {
    pub uid_validity: Option<u32>,
    pub low: Option<u32>,
    pub high: Option<u32>,
    pub complete: bool,
    /// The span was adopted from a pre-watermark cache and still has to be
    /// verified against the server (it may contain gaps).
    pub needs_repair: bool,
    pub highest_modseq: Option<u64>,
    /// Sorted, de-duplicated cached UIDs of the folder.
    pub cached_uids: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watermark {
    pub low: Option<u32>,
    pub high: Option<u32>,
    pub complete: bool,
    pub needs_repair: bool,
}

/// Result of one IMAP step before it is written to the cache.
#[derive(Debug, Serialize, Deserialize)]
pub struct FolderStepOutcome {
    pub folder: MailFolder,
    pub mode: MailSyncMode,
    pub messages: Vec<MailMessageCached>,
    pub vanished: Vec<u32>,
    pub flag_updates: Vec<(u32, Vec<String>)>,
    pub watermark: Watermark,
    /// New HIGHESTMODSEQ to store once flags were fully reconciled.
    pub highest_modseq: Option<u64>,
    pub reconciled: bool,
    pub uid_validity_reset: bool,
    pub remaining: usize,
    pub more: bool,
    pub new_unseen: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeaderStepRequest {
    pub account_id: String,
    pub folder: String,
    pub state: FolderSyncState,
    pub mode: MailSyncRequestMode,
    pub limit: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeaderPageRequest {
    pub account_id: String,
    pub folder: String,
    pub offset: u32,
    pub limit: u32,
    pub list_folders: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeaderPageOutcome {
    pub folders: Option<Vec<MailFolder>>,
    pub selected: MailFolder,
    pub messages: Vec<MailMessageCached>,
    pub has_more: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderRoundRequest {
    pub folder: MailFolder,
    pub state: FolderSyncState,
    pub limit: usize,
    pub reconcile: MailSyncRequestMode,
    pub skip_unchanged: bool,
}

#[derive(Default, Serialize, Deserialize)]
pub struct FolderRoundOutcome {
    pub steps: Vec<FolderStepOutcome>,
    pub pending: bool,
    pub unchanged: Option<MailFolder>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodySyncRequest {
    pub task: BodySyncTask,
    pub recent_limit: u32,
    pub max_bytes: u32,
    pub save_original: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum BodySyncTask {
    Page(HeaderPageRequest),
    Step(HeaderStepRequest),
    Round(FolderRoundRequest),
}

impl BodySyncTask {
    pub fn mailbox(&self) -> (&str, &str) {
        match self {
            Self::Page(request) => (&request.account_id, &request.folder),
            Self::Step(request) => (&request.account_id, &request.folder),
            Self::Round(request) => (&request.folder.account_id, &request.folder.name),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "outcome",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum BodySyncOutcome {
    Page(HeaderPageOutcome),
    Step(FolderStepOutcome),
    Round(FolderRoundOutcome),
}
