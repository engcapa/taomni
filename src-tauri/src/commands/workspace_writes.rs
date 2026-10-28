//! Keep ordered, potentially blocking file publication off the UI and async workers.
use crate::workspace::{
    WorkspaceFile, WorkspaceWriteAck, WorkspaceWriteEffect, WorkspaceWriteError,
    WorkspaceWriteErrorKind,
};

static WRITE_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn on_worker<T: Send + 'static>(
    write: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    // The old synchronous handlers serialized writes on the UI thread. Retain
    // that exclusion, but wait asynchronously and keep the guard with the real
    // operation even if its caller stops waiting for the response.
    let guard = WRITE_QUEUE.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        write()
    })
    .await
    .map_err(|error| format!("File save worker failed: {error}"))
}

fn worker_error(message: String) -> WorkspaceWriteError {
    // A worker can fail after publishing bytes, so never claim zero disk effect.
    WorkspaceWriteError::new(WorkspaceWriteErrorKind::Io, message)
        .with_effect(WorkspaceWriteEffect::Unknown, None)
}

#[tauri::command]
pub(super) async fn workspace_write_file(
    repo_root: String,
    path: String,
    contents: String,
    expected_hash: Option<String>,
) -> Result<WorkspaceFile, String> {
    on_worker(move || {
        crate::workspace::workspace_write_file(repo_root, path, contents, expected_hash)
    })
    .await?
}

#[tauri::command]
pub(super) async fn workspace_write_loose_file(
    path: String,
    contents: String,
    expected_hash: Option<String>,
) -> Result<WorkspaceFile, String> {
    on_worker(move || crate::workspace::workspace_write_loose_file(path, contents, expected_hash))
        .await?
}

#[tauri::command]
pub(super) async fn workspace_write_file_encoded(
    repo_root: String,
    path: String,
    contents: String,
    expected_hash: Option<String>,
    encoding: String,
    bom: Option<bool>,
) -> Result<WorkspaceWriteAck, WorkspaceWriteError> {
    on_worker(move || {
        crate::workspace::workspace_write_file_encoded(
            repo_root,
            path,
            contents,
            expected_hash,
            encoding,
            bom,
        )
    })
    .await
    .map_err(worker_error)?
}

#[tauri::command]
pub(super) async fn workspace_write_loose_file_encoded(
    path: String,
    contents: String,
    expected_hash: Option<String>,
    encoding: String,
    bom: Option<bool>,
) -> Result<WorkspaceWriteAck, WorkspaceWriteError> {
    on_worker(move || {
        crate::workspace::workspace_write_loose_file_encoded(
            path,
            contents,
            expected_hash,
            encoding,
            bom,
        )
    })
    .await
    .map_err(worker_error)?
}

#[cfg(test)]
#[path = "workspace_writes_tests.rs"]
mod tests;
