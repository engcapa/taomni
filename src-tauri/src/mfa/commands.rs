//! Tauri command surface for the MFA authenticator.
//!
//! Every command that reads or writes accounts first resolves the data key
//! from the vault (`VAULT_LOCKED` while it is locked), so locking the vault
//! immediately stops code generation. The outer admission/OS lease precedes
//! the MFA connection, then Vault; Vault never calls back into MFA.

use serde_json::json;
use taomni_mfa_engine::operations;
use tauri::State;
use tauri::ipc::Response;

use super::store::{MfaAccount, MfaAccountInput, MfaAccountPatch, MfaCode, MfaPrefs};
use super::{backend, capture, now_ms};
use crate::state::AppState;
use taomni_plugin_services::OperationKind;

pub use taomni_mfa_engine::models::{MfaAddResult, MfaInspectItem, MfaSnapshot};

#[tauri::command]
pub async fn mfa_list(state: State<'_, AppState>) -> Result<MfaSnapshot, String> {
    backend::run(
        &state,
        "mfa_list",
        OperationKind::ReadData,
        (),
        |_| json!({}),
        |conn, _, ()| operations::list(conn),
    )
    .await
}

#[tauri::command]
pub async fn mfa_codes(
    ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<MfaCode>, String> {
    let now = now_ms();
    backend::run(
        &state,
        "mfa_codes",
        OperationKind::ReadData,
        ids,
        |ids| json!({"ids": ids}),
        |conn, key, ids| operations::codes(conn, key, ids.as_deref(), now),
    )
    .await
}

#[tauri::command]
pub async fn mfa_inspect(
    inputs: Vec<MfaAccountInput>,
    state: State<'_, AppState>,
) -> Result<Vec<MfaInspectItem>, String> {
    backend::run(
        &state,
        "mfa_inspect",
        OperationKind::ReadData,
        inputs,
        |inputs| json!({"inputs": inputs}),
        |conn, key, inputs| operations::inspect(conn, key, &inputs),
    )
    .await
}

/// Validate every input first so one bad item never leaves a partial import.
#[tauri::command]
pub async fn mfa_add(
    inputs: Vec<MfaAccountInput>,
    skip_duplicates: bool,
    state: State<'_, AppState>,
) -> Result<MfaAddResult, String> {
    backend::run(
        &state,
        "mfa_add",
        OperationKind::WriteData,
        (inputs, skip_duplicates),
        |(inputs, skip)| json!({"inputs": inputs, "skipDuplicates": skip}),
        |conn, key, (inputs, skip)| operations::add(conn, key, &inputs, skip),
    )
    .await
}

#[tauri::command]
pub async fn mfa_update(
    id: String,
    patch: MfaAccountPatch,
    state: State<'_, AppState>,
) -> Result<MfaAccount, String> {
    backend::run(
        &state,
        "mfa_update",
        OperationKind::WriteData,
        (id, patch),
        |(id, patch)| json!({"id": id, "patch": patch}),
        |conn, _, (id, patch)| operations::update(conn, &id, &patch),
    )
    .await
}

#[tauri::command]
pub async fn mfa_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    backend::run(
        &state,
        "mfa_delete",
        OperationKind::WriteData,
        id,
        |id| json!({"id": id}),
        |conn, _, id| operations::delete(conn, &id),
    )
    .await
}

#[tauri::command]
pub async fn mfa_reorder(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    backend::run(
        &state,
        "mfa_reorder",
        OperationKind::WriteData,
        ids,
        |ids| json!({"ids": ids}),
        |conn, _, ids| operations::reorder(conn, &ids),
    )
    .await
}

#[tauri::command]
pub async fn mfa_hotp_next(id: String, state: State<'_, AppState>) -> Result<MfaCode, String> {
    backend::run(
        &state,
        "mfa_hotp_next",
        OperationKind::WriteData,
        id,
        |id| json!({"id": id}),
        |conn, key, id| operations::hotp_next(conn, key, &id),
    )
    .await
}

#[tauri::command]
pub async fn mfa_mark_used(id: String, state: State<'_, AppState>) -> Result<MfaAccount, String> {
    backend::run(
        &state,
        "mfa_mark_used",
        OperationKind::WriteData,
        id,
        |id| json!({"id": id}),
        |conn, _, id| operations::mark_used(conn, &id),
    )
    .await
}

#[tauri::command]
pub async fn mfa_set_prefs(prefs: MfaPrefs, state: State<'_, AppState>) -> Result<(), String> {
    backend::run(
        &state,
        "mfa_set_prefs",
        OperationKind::WriteData,
        prefs,
        |prefs| json!({"prefs": prefs}),
        |conn, _, prefs| operations::set_prefs(conn, &prefs),
    )
    .await
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
    backend::export(&state, id, zeroize::Zeroizing::new(master_password)).await
}

pub(crate) use super::access::export_with_password;

/// Destructive recovery when the vault no longer holds the key for `mfa.db`:
/// wipes every account and re-binds the empty store. The UI confirms twice.
#[tauri::command]
pub async fn mfa_reset_store(state: State<'_, AppState>) -> Result<(), String> {
    backend::reset(&state).await
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

/// Return raw frames to legacy callers. When a signed MFA host provides the
/// scanner, it decodes the frames granted by the core for this window.
#[tauri::command]
pub async fn mfa_capture_screens(
    window: tauri::WebviewWindow,
    decode: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    if decode == Some(true) {
        return backend::scan_in_host(&state, window)
            .await
            .and_then(|value| serde_json::to_string(&value).map_err(|error| error.to_string()))
            .map(Response::new);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = capture::capture_screens_hiding(&window)?;
        capture::retain_hosted_qa_scan(&window, &bytes);
        Ok::<_, String>(bytes)
    })
    .await
    .map_err(|e| format!("screen capture task: {e}"))?
    .map(Response::new)
}
