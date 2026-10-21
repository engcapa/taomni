use super::paths::expanded_path;
use crate::state::AppState;
use crate::state::ReadStreamHandle;
use crate::state::WriteStreamHandle;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::time::UNIX_EPOCH;
use tauri::State;
use tauri::ipc::InvokeBody;
use tauri::ipc::Request;
use tauri::ipc::Response;

pub(super) const MAX_READ_STREAM_CHUNK: usize = 1_048_576;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadStreamOpenResult {
    pub(super) handle_id: String,
    pub(super) size: u64,
    pub(super) mtime: u64,
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Response, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let bytes = std::fs::read(&expanded).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn read_stream_open(
    path: String,
    state: State<'_, AppState>,
) -> Result<ReadStreamOpenResult, String> {
    let expanded = expanded_path(&path);
    let file = OpenOptions::new()
        .read(true)
        .open(&expanded)
        .map_err(|e| format!("Failed to open read stream: {}", e))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to stat read stream: {}", e))?;
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let handle_id = uuid::Uuid::new_v4().to_string();
    let mut handles = state
        .files
        .read_handles
        .lock()
        .map_err(|e| format!("Read stream lock failed: {}", e))?;
    handles.insert(handle_id.clone(), ReadStreamHandle { file });
    Ok(ReadStreamOpenResult {
        handle_id,
        size,
        mtime,
    })
}

#[tauri::command]
pub fn read_stream_read(
    handle_id: String,
    max_bytes: usize,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    if !(1..=MAX_READ_STREAM_CHUNK).contains(&max_bytes) {
        return Err(format!(
            "read_stream_read maxBytes must be between 1 and {}",
            MAX_READ_STREAM_CHUNK
        ));
    }

    let mut handles = state
        .files
        .read_handles
        .lock()
        .map_err(|e| format!("Read stream lock failed: {}", e))?;
    let handle = handles
        .get_mut(&handle_id)
        .ok_or_else(|| format!("Read stream handle {} not found", handle_id))?;
    let mut bytes = vec![0_u8; max_bytes];
    let count = handle
        .file
        .read(&mut bytes)
        .map_err(|e| format!("Failed to read stream: {}", e))?;
    bytes.truncate(count);
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn read_stream_close(handle_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut handles = state
        .files
        .read_handles
        .lock()
        .map_err(|e| format!("Read stream lock failed: {}", e))?;
    handles
        .remove(&handle_id)
        .ok_or_else(|| format!("Read stream handle {} not found", handle_id))?;
    Ok(())
}

#[tauri::command]
pub fn write_stream_open(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let expanded = expanded_path(&path);
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&expanded)
        .map_err(|e| format!("Failed to open write stream: {}", e))?;
    let handle_id = uuid::Uuid::new_v4().to_string();
    let mut handles = state
        .files
        .write_handles
        .lock()
        .map_err(|e| format!("Write stream lock failed: {}", e))?;
    handles.insert(
        handle_id.clone(),
        WriteStreamHandle {
            path: expanded,
            file,
        },
    );
    Ok(handle_id)
}

#[tauri::command]
pub fn write_stream_append(request: Request<'_>, state: State<'_, AppState>) -> Result<(), String> {
    let handle_id = request
        .headers()
        .get("x-handle-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Missing x-handle-id header".to_string())?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("write_stream_append expects raw bytes".to_string()),
    };

    let mut handles = state
        .files
        .write_handles
        .lock()
        .map_err(|e| format!("Write stream lock failed: {}", e))?;
    let handle = handles
        .get_mut(handle_id)
        .ok_or_else(|| format!("Write stream handle {} not found", handle_id))?;
    handle
        .file
        .write_all(bytes)
        .map_err(|e| format!("Failed to append write stream: {}", e))
}

#[tauri::command]
pub fn write_stream_close(handle_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut handles = state
        .files
        .write_handles
        .lock()
        .map_err(|e| format!("Write stream lock failed: {}", e))?;
    let mut handle = handles
        .remove(&handle_id)
        .ok_or_else(|| format!("Write stream handle {} not found", handle_id))?;
    handle
        .file
        .flush()
        .map_err(|e| format!("Failed to flush write stream: {}", e))
}

#[tauri::command]
pub fn write_stream_abort(handle_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let handle = {
        let mut handles = state
            .files
            .write_handles
            .lock()
            .map_err(|e| format!("Write stream lock failed: {}", e))?;
        handles.remove(&handle_id)
    };
    if let Some(handle) = handle {
        drop(handle.file);
        let _ = std::fs::remove_file(handle.path);
    }
    Ok(())
}

#[tauri::command]
pub fn check_file_exists(path: String) -> bool {
    expanded_path(&path).exists()
}

#[tauri::command]
pub fn temporary_file_path(default_name: String) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("taomni");
    dir.push("query-results");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create temporary export directory: {}", e))?;

    let safe_name = default_name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>();
    let name = if safe_name.trim().is_empty() {
        "query-results.dat".to_string()
    } else {
        safe_name
    };
    dir.push(format!("{}-{}", uuid::Uuid::new_v4(), name));
    Ok(dir.to_string_lossy().into_owned())
}
