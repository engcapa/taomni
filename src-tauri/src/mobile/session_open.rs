//! Phone-initiated opening of saved sessions and new local terminals.
//!
//! The mobile service never creates a PTY itself. A request is delegated to the
//! desktop main window, which opens the tab through its normal flow (vault
//! unlock, SSH authentication prompts, proxies, jump hosts) and reports the
//! backend terminal key back through `mobile_open_session_result`. The phone
//! polls the request until the key arrives and then attaches to it like any
//! other running terminal. Opening is off until the desktop user enables it.

use super::{Core, MobileRuntime};
use crate::state::AppState;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

#[path = "connection_auth.rs"]
pub mod connection_auth;

/// Event the desktop main window handles (see `useMobileBridge.ts`).
pub const OPEN_EVENT: &str = "mobile-open-session";
const SETTINGS_FILE: &str = "mobile-open-sessions.json";
/// Long enough for a vault unlock or SSH keyboard-interactive prompt on the desktop.
const PENDING_TIMEOUT: Duration = Duration::from_secs(180);
const RETAIN: Duration = Duration::from_secs(600);
const MAX_PENDING_PER_DEVICE: usize = 4;
const MAX_RETAINED_REQUESTS: usize = 256;

#[derive(Clone, Debug, PartialEq)]
enum Outcome {
    Pending,
    Opened(String),
    Failed(String),
}

struct Request {
    device: String,
    /// Created by the Feishu adapter: identity was checked against the IM
    /// binding, so the desktop claim does not need a paired Web device.
    im: bool,
    created: Instant,
    outcome: Outcome,
    /// Once the desktop claims the request, the normal desktop connection flow
    /// owns it. Disabling future opens does not tear down an accepted connection.
    claimed: bool,
    terminal: Option<String>,
    auth: Option<connection_auth::PendingChallenge>,
    cancel: tokio_util::sync::CancellationToken,
}

#[derive(Default)]
pub struct OpenRequests {
    allowed: AtomicBool,
    /// Serializes initial load and persisted opt-in updates.
    loaded: Mutex<bool>,
    requests: Mutex<HashMap<String, Request>>,
}

impl OpenRequests {
    pub fn allowed(&self) -> bool {
        self.allowed.load(Ordering::Relaxed)
    }
    /// Reads the persisted opt-in once per process.
    pub fn ensure_loaded(&self, data: &Path) {
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        if *loaded {
            return;
        }
        let allowed = std::fs::read(data.join(SETTINGS_FILE))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
            .and_then(|value| value["allow_open_sessions"].as_bool())
            .unwrap_or(false);
        self.allowed.store(allowed, Ordering::Relaxed);
        *loaded = true;
    }
    pub fn set_allowed(&self, data: &Path, allowed: bool) -> Result<(), String> {
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        std::fs::create_dir_all(data).map_err(|_| "settings_write_failed")?;
        let target = data.join(SETTINGS_FILE);
        let temp = data.join(format!("{SETTINGS_FILE}.tmp"));
        let raw = serde_json::to_vec_pretty(&json!({ "allow_open_sessions": allowed }))
            .map_err(|_| "settings_write_failed")?;
        std::fs::write(&temp, raw).map_err(|_| "settings_write_failed")?;
        crate::atomic_replace::retry(|| std::fs::rename(&temp, &target))
            .map_err(|_| "settings_write_failed")?;
        *loaded = true;
        self.allowed.store(allowed, Ordering::Relaxed);
        if !allowed {
            // Withdrawn permission also ends requests the desktop has not served yet.
            let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
            for request in requests.values_mut() {
                if request.outcome == Outcome::Pending && !request.claimed {
                    request.outcome = Outcome::Failed("open_sessions_disabled".into());
                }
            }
        }
        Ok(())
    }
    fn prune(requests: &mut HashMap<String, Request>) {
        let now = Instant::now();
        requests.retain(|_, request| now.duration_since(request.created) < RETAIN);
        for request in requests.values_mut() {
            if request.outcome == Outcome::Pending
                && now.duration_since(request.created) >= PENDING_TIMEOUT
            {
                request.outcome = Outcome::Failed("open_timeout".into());
                request.auth = None;
                request.cancel.cancel();
            }
        }
    }
    fn insert(&self, device: &str, im: bool) -> Result<String, String> {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut requests);
        if requests.len() >= MAX_RETAINED_REQUESTS {
            return Err("too_many_open_requests".into());
        }
        let pending = requests
            .values()
            .filter(|r| r.device == device && r.outcome == Outcome::Pending)
            .count();
        if pending >= MAX_PENDING_PER_DEVICE {
            return Err("too_many_open_requests".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        requests.insert(
            id.clone(),
            Request {
                device: device.into(),
                im,
                created: Instant::now(),
                outcome: Outcome::Pending,
                claimed: false,
                terminal: None,
                auth: None,
                cancel: Default::default(),
            },
        );
        Ok(id)
    }
    fn remove(&self, id: &str) {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }
    /// Status for the device that made the request; other devices see nothing.
    pub fn poll(&self, device: &str, id: &str) -> Result<Value, String> {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut requests);
        let request = requests
            .get(id)
            .filter(|r| r.device == device)
            .ok_or("open_request_not_found")?;
        Ok(match &request.outcome {
            Outcome::Pending => {
                json!({"request_id":id, "status":"pending", "auth":request.auth.as_ref().map(|a| &a.challenge)})
            }
            Outcome::Opened(key) => {
                json!({"request_id":id, "status":"opened", "session_id":format!("term:{key}")})
            }
            Outcome::Failed(code) => json!({"request_id":id, "status":"failed", "error":code}),
        })
    }
    /// Claims a still-authorized request once, immediately before the desktop
    /// dispatch. Replayed events, revoked devices and expired requests do not
    /// open additional tabs. Accepted desktop work is not undone by a later poll.
    fn claim(&self, id: &str, authorized: impl FnOnce(&str) -> bool) -> bool {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut requests);
        let Some(request) = requests
            .get_mut(id)
            .filter(|r| r.outcome == Outcome::Pending && !r.claimed)
        else {
            return false;
        };
        if !self.allowed() || (!request.im && !authorized(&request.device)) {
            request.outcome = Outcome::Failed("open_cancelled".into());
            return false;
        }
        request.claimed = true;
        true
    }
    /// Desktop report. Only the first answer for a pending request counts.
    pub fn resolve(&self, id: &str, outcome: Result<String, String>) -> bool {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut requests);
        let Some(request) = requests
            .get_mut(id)
            .filter(|r| r.outcome == Outcome::Pending)
        else {
            return false;
        };
        request.outcome = match outcome {
            Ok(key) => Outcome::Opened(key),
            Err(code) => Outcome::Failed(error_code(&code)),
        };
        request.auth = None;
        if matches!(request.outcome, Outcome::Failed(_)) {
            request.cancel.cancel();
        }
        true
    }
}

/// Keeps desktop-reported failures to short machine codes the phone can map.
fn error_code(code: &str) -> String {
    let valid = !code.is_empty()
        && code.len() <= 48
        && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    if valid {
        code.into()
    } else {
        "open_failed".into()
    }
}

/// Whether the phone may ask this instance to open sessions right now.
pub fn available(state: &AppState) -> bool {
    state.mobile.open_requests.allowed() && state.mobile.desktop_available.load(Ordering::Relaxed)
}

/// Validates the request and hands it to the desktop main window.
pub fn start(
    core: &Core,
    runtime: &MobileRuntime,
    device: &str,
    body: &Value,
) -> Result<Value, String> {
    start_with(core, runtime, device, body, false)
}

/// IM-originated open request. The chat identity was already verified against
/// the configured binding, and the desktop still runs its normal open flow.
pub fn start_im(
    core: &Core,
    runtime: &MobileRuntime,
    device: &str,
    body: &Value,
) -> Result<Value, String> {
    start_with(core, runtime, device, body, true)
}

fn start_with(
    core: &Core,
    runtime: &MobileRuntime,
    device: &str,
    body: &Value,
    im: bool,
) -> Result<Value, String> {
    if !runtime.open_requests.allowed() {
        return Err("open_sessions_disabled".into());
    }
    let Some(app) = core.app() else {
        return Err("desktop_required".into());
    };
    if app.get_webview_window("main").is_none() {
        return Err("desktop_unavailable".into());
    }
    let kind = body["kind"].as_str().unwrap_or("");
    let saved = match kind {
        "local" => None,
        "saved" => {
            let id = body["saved_session_id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)
                .ok_or("saved_session_not_found")?;
            let state = core.state();
            let db = state.db.lock().map_err(|_| "database_unavailable")?;
            let session =
                crate::session::db::get_session(&db, id).map_err(|_| "saved_session_not_found")?;
            if !super::session_view::is_terminal_type(&session.session_type) {
                return Err("saved_session_not_terminal".into());
            }
            Some(session.id)
        }
        _ => return Err("invalid_open_request".into()),
    };
    let request_id = runtime.open_requests.insert(device, im)?;
    let payload = json!({"request_id":request_id, "kind":kind, "saved_session_id":saved});
    if app.emit_to("main", OPEN_EVENT, payload).is_err() {
        runtime.open_requests.remove(&request_id);
        return Err("desktop_unavailable".into());
    }
    Ok(json!({"request_id":request_id, "status":"pending"}))
}

/// Main-window-only authorization fence before opening a phone-requested tab.
#[tauri::command]
pub fn mobile_claim_open_session(
    request_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> bool {
    window.label() == "main"
        && state.mobile.open_requests.claim(&request_id, |device| {
            state
                .mobile
                .auth
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .exists(device)
        })
}

#[tauri::command]
pub fn mobile_open_session_result(
    request_id: String,
    terminal_id: Option<String>,
    error: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("desktop_required".into());
    }
    let outcome = match (terminal_id, error) {
        (Some(key), _) if state.mobile.broker.gate(&key).is_ok() => Ok(key),
        (Some(_), _) => Err("open_failed".to_string()),
        (None, Some(code)) => Err(code),
        (None, None) => Err("open_failed".to_string()),
    };
    Ok(state.mobile.open_requests.resolve(&request_id, outcome))
}

#[tauri::command]
pub fn mobile_set_open_sessions(
    enabled: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let data = crate::resolved_app_data_dir(&app)?;
    state.mobile.open_requests.set_allowed(&data, enabled)?;
    Ok(enabled)
}

/// Desktop tab title for a backend terminal key, shown in the phone session list.
#[tauri::command]
pub fn mobile_terminal_title(
    session_id: String,
    title: String,
    state: State<'_, AppState>,
) -> bool {
    state.mobile.broker.set_title(&session_id, &title)
}

#[cfg(test)]
#[path = "session_open_tests.rs"]
mod tests;
