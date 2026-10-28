//! Keep filesystem lookup, decoding and hashing outside the native UI thread.
use crate::workspace::WorkspaceFile;

async fn on_worker<T: Send + 'static>(
    command: &'static str,
    read: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    // Reads are independent. A slow mount/file must not queue unrelated reads
    // behind it or hold the SDK, language-service or UI executor.
    tauri::async_runtime::spawn_blocking(read)
        .await
        .map_err(|error| format!("{command}: file read worker failed: {error}"))
}

#[tauri::command]
pub(super) async fn workspace_read_file(
    repo_root: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    on_worker("workspace_read_file", move || {
        crate::workspace::workspace_read_file(repo_root, path, max_bytes)
    })
    .await?
}

#[tauri::command]
pub(super) async fn workspace_read_loose_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    on_worker("workspace_read_loose_file", move || {
        crate::workspace::workspace_read_loose_file(path, max_bytes)
    })
    .await?
}

#[tauri::command]
pub(super) async fn workspace_read_file_with_encoding(
    repo_root: String,
    path: String,
    max_bytes: Option<u64>,
    encoding: String,
) -> Result<WorkspaceFile, String> {
    on_worker("workspace_read_file_with_encoding", move || {
        crate::workspace::workspace_read_file_with_encoding(repo_root, path, max_bytes, encoding)
    })
    .await?
}

#[tauri::command]
pub(super) async fn workspace_read_loose_file_with_encoding(
    path: String,
    max_bytes: Option<u64>,
    encoding: String,
) -> Result<WorkspaceFile, String> {
    on_worker("workspace_read_loose_file_with_encoding", move || {
        crate::workspace::workspace_read_loose_file_with_encoding(path, max_bytes, encoding)
    })
    .await?
}

#[cfg(test)]
#[path = "workspace_reads_tests.rs"]
mod tests;
