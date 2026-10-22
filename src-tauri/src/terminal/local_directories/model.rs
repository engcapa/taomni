use serde::Serialize;

/// Availability as observed (or not observed within the probe budget).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    Unknown,
    Available,
    Missing,
    PermissionDenied,
    Unavailable,
}

impl Availability {
    pub fn as_str(self) -> &'static str {
        match self {
            Availability::Unknown => "unknown",
            Availability::Available => "available",
            Availability::Missing => "missing",
            Availability::PermissionDenied => "permission-denied",
            Availability::Unavailable => "unavailable",
        }
    }
}

/// Wire DTO consumed by the frontend (`src/lib/ipc.ts`). Rust serializes
/// `null` for absent optional fields so older browser fixtures read
/// null/unknown instead of failing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryShortcut {
    pub label: String,
    pub path: String,
    pub kind: String,
    pub directory_id: String,
    pub last_used_at_ms: Option<i64>,
    pub time_source: Option<String>,
    pub legacy_rank: Option<i64>,
    pub default_id: Option<String>,
    pub availability: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListEnvelope {
    pub revision: i64,
    pub directories: Vec<DirectoryShortcut>,
}

/// A persisted or in-memory candidate row before the final sort.
#[derive(Clone, Debug)]
pub struct DirectoryRow {
    pub directory_id: String,
    pub display_path: String,
    pub label: String,
    pub kind: String,
    pub last_used_at_ms: Option<i64>,
    pub time_source: Option<String>,
    pub legacy_rank: Option<i64>,
    pub default_rank: Option<u32>,
    pub default_id: Option<String>,
    /// Smallest registered path key; the stable identity sort key.
    pub identity_key: String,
    pub availability: Availability,
}

/// Response for the `record_local_directory_use` IPC command. The frontend
/// refreshes the sorted list via the revision event, so the returned
/// directory snapshot is informational only.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDirectoryUseResponse {
    pub changed: bool,
    pub directory: Option<DirectoryShortcut>,
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

pub(crate) struct PersistedRow {
    pub(crate) directory_id: String,
    pub(crate) display_path: String,
    pub(crate) label: String,
    pub(crate) kind: String,
    pub(crate) last_used_at_ms: Option<i64>,
    pub(crate) last_use_source: Option<String>,
    pub(crate) legacy_rank: Option<i64>,
    pub(crate) identity_key: String,
}
