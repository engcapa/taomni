use super::active::ActiveTerminal;
use crate::state::AppState;
use crate::terminal::local_directories;
use crate::terminal::pty;
use crate::terminal::x11;
use std::io::Read;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;

#[tauri::command]
pub fn list_local_shells() -> Vec<pty::LocalShellOption> {
    pty::list_local_shells()
}

#[tauri::command]
pub async fn list_common_local_directories(
    state: State<'_, AppState>,
) -> Result<local_directories::DirectoryListEnvelope, String> {
    // Block on the DB lock (the old try_lock fallback returned a fake
    // "defaults only" list, which silently lost history). Filesystem
    // probing happens inside `list_directory_shortcuts` without the DB
    // lock held.
    let db = state
        .db
        .lock()
        .map_err(|e| format!("session database is unavailable: {e}"))?;
    let mut db = db;
    local_directories::init_tables(&db).map_err(|e| e.to_string())?;
    local_directories::migrate_legacy_history(&mut db).map_err(|e| e.to_string())?;
    local_directories::list_directory_shortcuts(&db)
}

/// Frontend-driven confirmed cwd report from a live native-local terminal
/// (OSC 7). Clicks, queueing, failed spawns and remote/WSL paths never
/// reach this command.
#[tauri::command]
pub async fn record_local_directory_use(
    backend_session_id: String,
    path: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<local_directories::RecordDirectoryUseResponse, String> {
    // Only live native-local terminals may record use. Async lock: this runs
    // on the Tokio runtime, where `blocking_read` would panic.
    {
        let terminals = state.terminal.terminals.read().await;
        match terminals.get(&backend_session_id) {
            Some(ActiveTerminal::Local { .. }) => {}
            _ => {
                return Err(format!(
                    "terminal {backend_session_id} is not a live local terminal"
                ));
            }
        }
    }
    record_local_directory_use_inner(&backend_session_id, &path, &state, &app_handle)
}

pub(crate) fn record_local_directory_use_inner(
    backend_session_id: &str,
    path: &str,
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<local_directories::RecordDirectoryUseResponse, String> {
    if backend_session_id.trim().is_empty() {
        return Err("backend session id is required".to_string());
    }
    // Per-runtime dedup: repeated prompts/cwd probes for the same directory
    // never rewrite the record.
    let path_buf = std::path::PathBuf::from(path);
    let Some(new_key) = local_directories::normalize_path_key(&path_buf) else {
        return Err(format!("invalid local directory path: {path}"));
    };
    if let Some(last) = state
        .terminal
        .local_directory_runtime
        .lock()
        .ok()
        .and_then(|r| r.get(backend_session_id).cloned())
    {
        if last == new_key {
            return Ok(local_directories::RecordDirectoryUseResponse {
                changed: false,
                directory: None,
            });
        }
    }
    let now_ms = local_directories::system_now_ms();
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    local_directories::init_tables(&db).map_err(|e| e.to_string())?;
    let (changed, revision) = local_directories::record_directory_use(
        &mut db,
        &path_buf,
        local_directories::SOURCE_LOCAL_CWD,
        now_ms,
    )?;
    if let Ok(mut runtime) = state.terminal.local_directory_runtime.lock() {
        runtime.insert(backend_session_id.to_string(), new_key);
    }
    if changed {
        let _ = app_handle.emit(
            "welcome-directories-changed",
            serde_json::json!({ "revision": revision }),
        );
    }
    Ok(local_directories::RecordDirectoryUseResponse {
        changed,
        directory: None,
    })
}

/// Rust-internal confirmed spawn write. Called from the success path of
/// `create_local_terminal` with the requested cwd; the frontend can never
/// pass arbitrary times or treat clicks as successes.
pub(crate) fn record_successful_local_start(
    state: &AppState,
    app_handle: &AppHandle,
    backend_session_id: &str,
    requested_cwd: Option<&str>,
) -> Option<String> {
    let Some(cwd) = requested_cwd.map(str::trim).filter(|c| !c.is_empty()) else {
        // No requested cwd: first confirmed OSC 7 will record instead.
        return None;
    };
    let path = std::path::PathBuf::from(cwd);
    let Some(new_key) = local_directories::normalize_path_key(&path) else {
        return None;
    };
    let now_ms = local_directories::system_now_ms();
    let mut db = match state.db.lock() {
        Ok(db) => db,
        Err(e) => {
            return Some(format!("local directory history save failed: {e}"));
        }
    };
    let result = local_directories::record_directory_use(
        &mut db,
        &path,
        local_directories::SOURCE_LOCAL_START,
        now_ms,
    );
    if let Ok(mut runtime) = state.terminal.local_directory_runtime.lock() {
        runtime.insert(backend_session_id.to_string(), new_key);
    }
    match result {
        Ok((true, revision)) => {
            let _ = app_handle.emit(
                "welcome-directories-changed",
                serde_json::json!({ "revision": revision }),
            );
            None
        }
        Ok((false, _)) => None,
        Err(error) => Some(format!("local directory history save failed: {error}")),
    }
}

/// Probe the local system X server (Xorg / XQuartz / VcXsrv / WSLg) and report
/// whether X11 forwarding has somewhere to display. Drives the X-server status
/// pill and the "install XQuartz/VcXsrv" hints in the UI.
#[tauri::command]
pub fn detect_x_server() -> x11::XServerStatus {
    x11::detect()
}

#[tauri::command]
pub fn open_local_shell_as_administrator(shell: Option<String>) -> Result<(), String> {
    pty::open_shell_as_administrator(shell)
}
