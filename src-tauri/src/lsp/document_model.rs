use super::feature_model::LspDiagnostic;
use super::status_model::LspServerPreset;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Instant;

pub(super) struct WorkspaceWatcherHandle {
    pub(super) cancelled: tokio_util::sync::CancellationToken,
    pub(super) task: tokio::task::JoinHandle<()>,
}

#[derive(Clone, Debug)]
pub(super) struct WorkspaceWatchTarget {
    /// Whether notify should recurse below the requested directory.
    pub(super) recursive: bool,
    /// A broad home root or explicitly loaded directory watches its immediate
    /// children without recursively registering the entire home filesystem.
    pub(super) direct_children: bool,
    /// Logical path used to discard events outside the requested workspace root
    /// or loose file. For a missing loose file this is the file itself, not its
    /// parent directory.
    pub(super) filter_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum LocalWatchedSnapshot {
    Missing,
    File(String),
}

#[derive(Clone, Debug)]
pub(super) struct LocalWatchedEvent {
    pub(super) at: Instant,
    pub(super) snapshot: LocalWatchedSnapshot,
}

#[derive(Clone)]
pub(super) struct ResolvedDocument {
    pub(super) path: PathBuf,
    pub(super) uri: String,
    pub(super) root_path: PathBuf,
    pub(super) workspace_id: String,
    pub(super) preset: Option<LspServerPreset>,
    pub(super) language_id: Option<String>,
    pub(super) version: i64,
}

/// One file's diagnostics for the workspace-wide Problems view (M7-C).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiagnosticFile {
    /// Absolute filesystem path (from the `file:` URI).
    pub path: String,
    pub uri: String,
    pub diagnostics: Vec<LspDiagnostic>,
}

/// Convert a `file:` URI to an absolute path; `None` for `jdt://` / non-file URIs.
pub(super) fn file_path_from_uri(uri: &str) -> Option<String> {
    url::Url::parse(uri)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}
