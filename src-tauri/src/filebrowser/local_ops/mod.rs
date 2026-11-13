//! Explorer-only filesystem commands. Existing SFTP command signatures and
//! permanent-delete semantics remain untouched for the dual-pane browser.
mod inspection;
mod model;
mod operation;
mod paths;
mod transfer;
mod trash;
#[cfg(windows)]
mod windows_trash;

pub use model::{
    EntryOperationResult, LocalProperties, PreviewBytes, PreviewText, TrashRef, TrashResult,
};
use operation::Operation;
use std::path::Path;

async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|e| format!("Explorer worker failed: {e}"))?
}

#[tauri::command]
pub async fn explorer_canonical_path(path: String) -> Result<String, String> {
    blocking(move || paths::canonical_key(Path::new(&path)).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn explorer_same_volume(source: String, dest_dir: String) -> Result<bool, String> {
    blocking(move || {
        paths::same_volume(Path::new(&source), Path::new(&dest_dir)).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn local_copy_entries(
    sources: Vec<String>,
    dest_dir: String,
    conflict: Option<String>,
    operation_id: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<EntryOperationResult, String> {
    start_transfer(sources, dest_dir, conflict, operation_id, false, app_handle).await
}

#[tauri::command]
pub async fn local_move_entries(
    sources: Vec<String>,
    dest_dir: String,
    conflict: Option<String>,
    operation_id: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<EntryOperationResult, String> {
    start_transfer(sources, dest_dir, conflict, operation_id, true, app_handle).await
}

async fn start_transfer(
    sources: Vec<String>,
    dest_dir: String,
    conflict: Option<String>,
    operation_id: Option<String>,
    moving: bool,
    app_handle: tauri::AppHandle,
) -> Result<EntryOperationResult, String> {
    if sources.len() > 10_000 {
        return Err(
            "too_many_entries: At most 10,000 source paths can be submitted at once".into(),
        );
    }
    if conflict.is_some_and(|mode| mode != "rename") {
        return Err("invalid_conflict: Only safe conflict renaming is supported".into());
    }
    // Register before queueing the worker so cancellation cannot race ahead of
    // an unregistered background copy waiting for a blocking-pool slot.
    let mut operation =
        Operation::register(operation_id, Some(app_handle)).map_err(|e| e.to_string())?;
    blocking(move || {
        Ok(transfer::transfer_entries(
            sources,
            Path::new(&dest_dir),
            moving,
            &mut operation,
        ))
    })
    .await
}

#[tauri::command]
pub fn explorer_cancel_operation(operation_id: String) -> Result<(), String> {
    operation::cancel(&operation_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_trash_entries(paths: Vec<String>) -> Result<TrashResult, String> {
    if paths.len() > 10_000 {
        return Err(
            "too_many_entries: At most 10,000 source paths can be submitted at once".into(),
        );
    }
    blocking(move || Ok(trash::trash_entries(paths))).await
}

#[tauri::command]
pub async fn local_trash_restore(items: Vec<TrashRef>) -> Result<EntryOperationResult, String> {
    blocking(move || Ok(trash::restore_entries(items))).await
}

#[tauri::command]
pub async fn local_properties(
    path: String,
    operation_id: Option<String>,
) -> Result<LocalProperties, String> {
    let mut operation = Operation::register(operation_id, None).map_err(|e| e.to_string())?;
    blocking(move || {
        inspection::properties(Path::new(&path), &mut operation).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn explorer_read_preview_bytes(
    path: String,
    max_bytes: Option<u64>,
) -> Result<PreviewBytes, String> {
    blocking(move || {
        inspection::preview_bytes(Path::new(&path), max_bytes.unwrap_or(20 * 1024 * 1024))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn explorer_read_preview_text(path: String) -> Result<PreviewText, String> {
    blocking(move || inspection::preview_text(Path::new(&path)).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn local_rename_entry(path: String, name: String) -> Result<String, String> {
    blocking(move || transfer::rename_entry(Path::new(&path), &name).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
pub async fn local_create_entry(
    dest_dir: String,
    name: String,
    directory: bool,
) -> Result<String, String> {
    blocking(move || {
        transfer::create_entry(Path::new(&dest_dir), &name, directory).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests;
