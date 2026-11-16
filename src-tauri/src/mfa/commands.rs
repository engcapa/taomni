//! Tauri command surface for the MFA authenticator.
//!
//! Every command that reads or writes accounts first resolves the data key
//! from the vault (`VAULT_LOCKED` while it is locked), so locking the vault
//! immediately stops code generation. The outer admission/OS lease precedes
//! the MFA connection, then Vault; Vault never calls back into MFA.

use taomni_mfa_engine::operations;
use tauri::State;
use tauri::ipc::Response;

use super::crypto::DataKey;
use super::store::{MfaAccount, MfaAccountInput, MfaAccountPatch, MfaCode, MfaPrefs};
use super::{capture, now_ms};
use crate::state::AppState;
use taomni_plugin_services::OperationKind;

pub use taomni_mfa_engine::models::{MfaAddResult, MfaInspectItem, MfaSnapshot};

fn with_key<T>(
    state: &AppState,
    kind: OperationKind,
    f: impl FnOnce(&mut rusqlite::Connection, &DataKey) -> Result<T, String>,
) -> Result<T, String> {
    super::access::with_key(
        &state.plugins,
        &state.core.vault,
        &state.legacy.mfa,
        kind,
        f,
    )
}

#[tauri::command]
pub async fn mfa_list(state: State<'_, AppState>) -> Result<MfaSnapshot, String> {
    with_key(&state, OperationKind::ReadData, |conn, _| {
        operations::list(conn)
    })
}

#[tauri::command]
pub async fn mfa_codes(
    ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<MfaCode>, String> {
    let now = now_ms();
    with_key(&state, OperationKind::ReadData, |conn, key| {
        operations::codes(conn, key, ids.as_deref(), now)
    })
}

#[tauri::command]
pub async fn mfa_inspect(
    inputs: Vec<MfaAccountInput>,
    state: State<'_, AppState>,
) -> Result<Vec<MfaInspectItem>, String> {
    with_key(&state, OperationKind::ReadData, |conn, key| {
        operations::inspect(conn, key, &inputs)
    })
}

/// Validate every input first so one bad item never leaves a partial import.
#[tauri::command]
pub async fn mfa_add(
    inputs: Vec<MfaAccountInput>,
    skip_duplicates: bool,
    state: State<'_, AppState>,
) -> Result<MfaAddResult, String> {
    with_key(&state, OperationKind::WriteData, |conn, key| {
        operations::add(conn, key, &inputs, skip_duplicates)
    })
}

#[tauri::command]
pub async fn mfa_update(
    id: String,
    patch: MfaAccountPatch,
    state: State<'_, AppState>,
) -> Result<MfaAccount, String> {
    with_key(&state, OperationKind::WriteData, |conn, _| {
        operations::update(conn, &id, &patch)
    })
}

#[tauri::command]
pub async fn mfa_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    with_key(&state, OperationKind::WriteData, |conn, _| {
        operations::delete(conn, &id)
    })
}

#[tauri::command]
pub async fn mfa_reorder(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    with_key(&state, OperationKind::WriteData, |conn, _| {
        operations::reorder(conn, &ids)
    })
}

#[tauri::command]
pub async fn mfa_hotp_next(id: String, state: State<'_, AppState>) -> Result<MfaCode, String> {
    with_key(&state, OperationKind::WriteData, |conn, key| {
        operations::hotp_next(conn, key, &id)
    })
}

#[tauri::command]
pub async fn mfa_mark_used(id: String, state: State<'_, AppState>) -> Result<MfaAccount, String> {
    with_key(&state, OperationKind::WriteData, |conn, _| {
        operations::mark_used(conn, &id)
    })
}

#[tauri::command]
pub async fn mfa_set_prefs(prefs: MfaPrefs, state: State<'_, AppState>) -> Result<(), String> {
    with_key(&state, OperationKind::WriteData, |conn, _| {
        operations::set_prefs(conn, &prefs)
    })
}

/// `otpauth://` link for one account, rendered as a QR code so another
/// authenticator can scan it. This is the only command that hands a stored
/// secret to the renderer, so it re-checks the master password even while the
/// vault is unlocked (`VAULT_BAD_PASSWORD` / `VAULT_PASSWORD_REQUIRED`).
#[tauri::command]
pub async fn mfa_export_uri(
    id: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let password = zeroize::Zeroizing::new(master_password);
    export_with_password(
        &state.plugins,
        &state.core.vault,
        &state.legacy.mfa,
        &id,
        &password,
    )
}

pub(crate) use super::access::export_with_password;

/// Destructive recovery when the vault no longer holds the key for `mfa.db`:
/// wipes every account and re-binds the empty store. The UI confirms twice.
#[tauri::command]
pub async fn mfa_reset_store(state: State<'_, AppState>) -> Result<(), String> {
    super::access::reset_store(&state.plugins, &state.core.vault, &state.legacy.mfa)
}

/// Clipboard image as luma frames (see [`capture::encode_frames`]). Runs off
/// the main thread: on X11 the owner may be our own WebKitGTK process.
#[tauri::command]
pub async fn mfa_read_clipboard_image(state: State<'_, AppState>) -> Result<Response, String> {
    let clipboard = state.core.clipboard.clone();
    tauri::async_runtime::spawn_blocking(move || capture::read_clipboard_image(&clipboard))
        .await
        .map_err(|e| format!("clipboard task: {e}"))?
        .map(Response::new)
}

/// Hide the calling window, capture every display and return luma frames.
#[tauri::command]
pub async fn mfa_capture_screens(window: tauri::WebviewWindow) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = capture::capture_screens_hiding(&window)?;
        capture::retain_hosted_qa_scan(&window, &bytes);
        Ok::<_, String>(bytes)
    })
    .await
    .map_err(|e| format!("screen capture task: {e}"))?
    .map(Response::new)
}
