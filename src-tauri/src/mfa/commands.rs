//! Tauri command surface for the MFA authenticator.
//!
//! Every command that reads or writes accounts first resolves the data key
//! from the vault (`VAULT_LOCKED` while it is locked), so locking the vault
//! immediately stops code generation. Lock order is always MFA connection,
//! then vault; the vault never calls back into MFA.

use serde::Serialize;
use tauri::State;
use tauri::ipc::Response;

use super::crypto::{self, DataKey};
use super::otp;
use super::store::{self, MfaAccount, MfaAccountInput, MfaAccountPatch, MfaCode, MfaPrefs};
use super::{ERR_NOT_FOUND, capture, now_ms};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaSnapshot {
    pub accounts: Vec<MfaAccount>,
    pub prefs: MfaPrefs,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaInspectItem {
    pub ok: bool,
    pub error: Option<String>,
    pub duplicate_of: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaAddResult {
    pub added: Vec<MfaAccount>,
    /// Input indexes skipped because an identical account already exists.
    pub duplicates: Vec<usize>,
}

fn with_key<T>(
    state: &AppState,
    f: impl FnOnce(&mut rusqlite::Connection, &DataKey) -> Result<T, String>,
) -> Result<T, String> {
    state.mfa.with_conn(|conn| {
        let key = crypto::ensure_key(conn, &state.vault)?;
        f(conn, &key)
    })
}

fn not_found() -> String {
    ERR_NOT_FOUND.to_string()
}

#[tauri::command]
pub async fn mfa_list(state: State<'_, AppState>) -> Result<MfaSnapshot, String> {
    with_key(&state, |conn, _| {
        Ok(MfaSnapshot {
            accounts: store::list_accounts(conn)?,
            prefs: store::get_prefs(conn)?,
        })
    })
}

#[tauri::command]
pub async fn mfa_codes(
    ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<MfaCode>, String> {
    let now = now_ms();
    with_key(&state, |conn, key| {
        let mut codes = Vec::new();
        for sealed in store::list_sealed(conn)? {
            if ids
                .as_ref()
                .is_some_and(|wanted| !wanted.contains(&sealed.account.id))
            {
                continue;
            }
            let secret = store::open_secret(key, &sealed)?;
            codes.push(store::code_for(&sealed.account, &secret, now));
        }
        Ok(codes)
    })
}

#[tauri::command]
pub async fn mfa_inspect(
    inputs: Vec<MfaAccountInput>,
    state: State<'_, AppState>,
) -> Result<Vec<MfaInspectItem>, String> {
    with_key(&state, |conn, key| {
        inputs
            .iter()
            .map(|input| match store::validate_input(input) {
                Ok(valid) => Ok(MfaInspectItem {
                    ok: true,
                    error: None,
                    duplicate_of: store::find_duplicate(conn, &store::fingerprint_of(key, &valid))?,
                }),
                Err(error) => Ok(MfaInspectItem {
                    ok: false,
                    error: Some(error),
                    duplicate_of: None,
                }),
            })
            .collect()
    })
}

/// Validate every input first so one bad item never leaves a partial import.
#[tauri::command]
pub async fn mfa_add(
    inputs: Vec<MfaAccountInput>,
    skip_duplicates: bool,
    state: State<'_, AppState>,
) -> Result<MfaAddResult, String> {
    with_key(&state, |conn, key| {
        let valid = inputs
            .iter()
            .map(store::validate_input)
            .collect::<Result<Vec<_>, _>>()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("mfa database: {e}"))?;
        let mut result = MfaAddResult {
            added: Vec::new(),
            duplicates: Vec::new(),
        };
        for (index, account) in valid.iter().enumerate() {
            let fingerprint = store::fingerprint_of(key, account);
            if store::find_duplicate(&tx, &fingerprint)?.is_some() {
                if skip_duplicates {
                    result.duplicates.push(index);
                    continue;
                }
                return Err(format!(
                    "{}: secret: account already exists",
                    super::ERR_INVALID_INPUT
                ));
            }
            result.added.push(store::insert_account(&tx, key, account)?);
        }
        tx.commit().map_err(|e| format!("mfa database: {e}"))?;
        Ok(result)
    })
}

#[tauri::command]
pub async fn mfa_update(
    id: String,
    patch: MfaAccountPatch,
    state: State<'_, AppState>,
) -> Result<MfaAccount, String> {
    with_key(&state, |conn, _| {
        store::update_account(conn, &id, &patch)?.ok_or_else(not_found)
    })
}

#[tauri::command]
pub async fn mfa_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    with_key(&state, |conn, _| {
        if store::delete_account(conn, &id)? {
            Ok(())
        } else {
            Err(not_found())
        }
    })
}

#[tauri::command]
pub async fn mfa_reorder(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    with_key(&state, |conn, _| store::reorder(conn, &ids))
}

#[tauri::command]
pub async fn mfa_hotp_next(id: String, state: State<'_, AppState>) -> Result<MfaCode, String> {
    with_key(&state, |conn, key| {
        if !store::increment_counter(conn, &id)? {
            return Err(not_found());
        }
        let sealed = store::get_sealed(conn, &id)?.ok_or_else(not_found)?;
        let secret = store::open_secret(key, &sealed)?;
        Ok(store::code_for(&sealed.account, &secret, now_ms()))
    })
}

#[tauri::command]
pub async fn mfa_mark_used(id: String, state: State<'_, AppState>) -> Result<MfaAccount, String> {
    with_key(&state, |conn, _| {
        store::mark_used(conn, &id)?.ok_or_else(not_found)
    })
}

#[tauri::command]
pub async fn mfa_set_prefs(prefs: MfaPrefs, state: State<'_, AppState>) -> Result<(), String> {
    with_key(&state, |conn, _| store::set_prefs(conn, &prefs))
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
    export_with_password(&state.vault, &state.mfa, &id, &master_password)
}

pub(crate) fn export_with_password(
    vault: &crate::vault::Vault,
    mfa: &store::MfaStore,
    id: &str,
    master_password: &str,
) -> Result<String, String> {
    // Before touching mfa.db, so the lock order stays MFA connection → vault.
    vault.verify_master_password(Some(master_password))?;
    mfa.with_conn(|conn| {
        let key = crypto::ensure_key(conn, vault)?;
        export_uri(conn, &key, id)
    })
}

fn export_uri(conn: &rusqlite::Connection, key: &DataKey, id: &str) -> Result<String, String> {
    let sealed = store::get_sealed(conn, id)?.ok_or_else(not_found)?;
    let secret = store::open_secret(key, &sealed)?;
    let account = &sealed.account;
    Ok(otp::otpauth_uri(&otp::OtpauthFields {
        kind: account.kind,
        issuer: &account.issuer,
        account_name: &account.account_name,
        secret: &secret,
        algorithm: account.algorithm,
        digits: account.digits,
        period: account.period,
        counter: account.counter,
    }))
}

/// Destructive recovery when the vault no longer holds the key for `mfa.db`:
/// wipes every account and re-binds the empty store. The UI confirms twice.
#[tauri::command]
pub async fn mfa_reset_store(state: State<'_, AppState>) -> Result<(), String> {
    state.mfa.with_conn(|conn| {
        // Probe the vault first so a locked vault never wipes anything.
        state
            .vault
            .get_fixed(crate::vault::MFA_DATA_KEY_ENTRY_ID)
            .map(|_| ())?;
        store::reset(conn)?;
        crypto::rebind_after_reset(conn, &state.vault).map(|_| ())
    })
}

/// Clipboard image as luma frames (see [`capture::encode_frames`]). Runs off
/// the main thread: on X11 the owner may be our own WebKitGTK process.
#[tauri::command]
pub async fn mfa_read_clipboard_image(state: State<'_, AppState>) -> Result<Response, String> {
    let clipboard = state.clipboard.clone();
    tauri::async_runtime::spawn_blocking(move || capture::read_clipboard_image(&clipboard))
        .await
        .map_err(|e| format!("clipboard task: {e}"))?
        .map(Response::new)
}

/// Hide the calling window, capture every display and return luma frames.
#[tauri::command]
pub async fn mfa_capture_screens(window: tauri::WebviewWindow) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || capture::capture_screens_hiding(&window))
        .await
        .map_err(|e| format!("screen capture task: {e}"))?
        .map(Response::new)
}
