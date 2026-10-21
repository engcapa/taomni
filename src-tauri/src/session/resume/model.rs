use serde::Deserialize;
use serde::Serialize;

pub const SNAPSHOT_SCHEMA_VERSION: i64 = 1;
/// Revision counter survives row deletion (clear + rebuild must not alias an
/// older revision: design §4.3).
pub(super) const METADATA_REVISION: &str = "welcome_run_snapshot_revision";
pub(super) const METADATA_RUN_SEQUENCE: &str = "welcome_run_snapshot_sequence";
pub(super) const METADATA_CLEAR_MARKER: &str = "session_resume_cleared_v1";
pub(super) const MAX_ENTRIES: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum SnapshotEntry {
    #[serde(rename = "saved-session")]
    SavedSession {
        #[serde(rename = "identity")]
        identity: String,
        #[serde(rename = "savedSessionId")]
        saved_session_id: String,
        /// Raw persisted type string; never defaulted to another protocol.
        #[serde(rename = "savedSessionType")]
        saved_session_type: String,
        #[serde(rename = "displayName")]
        display_name: String,
    },
    #[serde(rename = "local-terminal")]
    LocalTerminal {
        #[serde(rename = "identity")]
        identity: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "shellId")]
        shell_id: String,
        #[serde(rename = "shellArgs")]
        shell_args: Vec<String>,
        #[serde(rename = "confirmedCwd")]
        confirmed_cwd: String,
    },
}

impl SnapshotEntry {
    pub fn identity(&self) -> &str {
        match self {
            SnapshotEntry::SavedSession { identity, .. } => identity,
            SnapshotEntry::LocalTerminal { identity, .. } => identity,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshotRecord {
    pub schema_version: i64,
    pub revision: i64,
    pub run_sequence: i64,
    pub batch_id: String,
    pub committed_at_ms: i64,
    pub entries: Vec<SnapshotEntry>,
    pub active_identity: Option<String>,
}

/// Frontend-facing issue attached to a snapshot read (design §4.2.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotIssue {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRunSnapshotResponse {
    pub record: Option<RunSnapshotRecord>,
    pub legacy_candidate: Option<SnapshotEntry>,
    pub issue: Option<SnapshotIssue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRunSnapshotResponse {
    pub record: Option<RunSnapshotRecord>,
    pub applied: bool,
}
