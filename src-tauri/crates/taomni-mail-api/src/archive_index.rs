//! Mail archive entries, filters, and cleanup receipts.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const QUERY_ARCHIVE_INDEX: &str = "mail/query-archive-index";
pub const CLEANUP_ARCHIVE_INDEX: &str = "mail/cleanup-archive-index";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveIndexRequest {
    pub account_id: String,
    pub source: ArchiveIndexSource,
    pub action: ArchiveIndexAction,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ArchiveIndexSource {
    AccountCache { database: PathBuf },
    ModuleData,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ArchiveIndexAction {
    Find { query: ArchiveQuery, offset: u32 },
    List { offset: u32 },
    Preview { selection: ArchiveSelection },
    Cleanup { token: String },
    Remove { entries: Vec<ArchiveEntry> },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub folder: String,
    pub uid: u32,
    pub uid_validity: u32,
    pub subject: String,
    pub raw_size: u64,
    pub stored_size: u64,
    pub stored_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArchiveQuery {
    pub text: String,
    pub field: SearchField,
    pub folder: Option<String>,
    pub has_attachments: Option<bool>,
    pub date_from: Option<i64>,
    pub date_before: Option<i64>,
    pub stored_from: Option<i64>,
    pub stored_before: Option<i64>,
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
    pub sort: ArchiveSort,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchField {
    #[default]
    All,
    Subject,
    From,
    To,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveSort {
    #[default]
    SavedNewest,
    SavedOldest,
    DateNewest,
    DateOldest,
    Largest,
    Smallest,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveKey {
    pub folder: String,
    pub uid: u32,
    pub uid_validity: u32,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSelection {
    pub query: Option<ArchiveQuery>,
    #[serde(default)]
    pub keys: Vec<ArchiveKey>,
    #[serde(default)]
    pub excluded: Vec<ArchiveKey>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRow {
    #[serde(flatten)]
    pub entry: ArchiveEntry,
    pub from: String,
    pub to: String,
    pub date_ts: Option<i64>,
    pub has_attachments: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePage {
    pub entries: Vec<ArchiveRow>,
    pub total: u64,
    pub stored_bytes: u64,
    pub folders: Vec<String>,
    pub offset: u32,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    pub token: String,
    pub count: u64,
    pub stored_bytes: u64,
    pub reclaimable_bytes: u64,
}
