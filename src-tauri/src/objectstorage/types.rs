//! Wire DTOs shared between the object-storage backend and the frontend.
//! All fields serialize as camelCase to match the TypeScript types in
//! `src/types/objectStorage.ts`.

use serde::{Deserialize, Serialize};

/// A bucket (S3) or container (Azure) at the account/service root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketEntry {
    pub name: String,
    /// Creation time, seconds since the UNIX epoch, when the provider reports it.
    pub created_at: Option<i64>,
    pub region: Option<String>,
}

/// One row in an object listing: either a real object or a synthetic "folder"
/// derived from a common prefix (delimiter-based listing).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEntry {
    /// Display name — the last path segment relative to the current prefix.
    pub name: String,
    /// Full object key, or the common prefix (with trailing `/`) for a folder.
    pub key: String,
    /// True for a common-prefix folder, false for a real object.
    pub is_dir: bool,
    pub size: u64,
    /// Last-modified time, seconds since the UNIX epoch.
    pub last_modified: Option<i64>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

/// One page of an object listing. `next_token` is the continuation token for
/// lazy pagination of large buckets; `None` means the listing is complete.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectListPage {
    pub entries: Vec<ObjectEntry>,
    pub next_token: Option<String>,
}

/// Detailed metadata for a single object, from a HEAD request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMetadata {
    pub key: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    /// Last-modified time, seconds since the UNIX epoch.
    pub last_modified: Option<i64>,
    pub storage_class: Option<String>,
    pub cache_control: Option<String>,
    pub content_encoding: Option<String>,
    pub content_disposition: Option<String>,
    /// User-defined metadata (`x-amz-meta-*` / `x-ms-meta-*`), keys lowercased.
    pub user_metadata: std::collections::BTreeMap<String, String>,
}

/// Progress tick for an upload/download, emitted on `storage-progress-{transferId}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTransferProgress {
    pub bytes: u64,
    pub total: u64,
    /// Throughput in bytes/sec.
    pub rate: f64,
    /// Estimated seconds remaining.
    pub eta: f64,
}
