//! Tauri commands for Sockscap Phase 0.
//!
//! Command surface follows design plan §12. Write commands re-validate on the
//! Rust side; capture install is not available yet.

use tauri::State;

use super::capabilities::probe_capabilities;
use super::orchestrator::SockscapEngine;
use super::preflight::{run_preflight, PreflightReport};
use super::types::{CapabilitiesReport, EngineStatus, RoutingProfileDraft};
use crate::state::AppState;

/// Probe host capabilities without mutating system network state.
#[tauri::command]
pub fn sockscap_capabilities() -> CapabilitiesReport {
    probe_capabilities()
}

/// Return the current engine status snapshot.
#[tauri::command]
pub fn sockscap_status(state: State<'_, AppState>) -> EngineStatus {
    state.sockscap.status()
}

/// Run preflight against an optional set of profile drafts.
///
/// Empty input still probes the host so the UI can show capability banners
/// before the user has saved any profiles.
#[tauri::command]
pub fn sockscap_preflight(profiles: Option<Vec<RoutingProfileDraft>>) -> PreflightReport {
    let profiles = profiles.unwrap_or_default();
    run_preflight(&profiles)
}

/// Attempt to start the engine. Phase 0 always fails preflight (capture not
/// implemented) but exercises the full start error path.
#[tauri::command]
pub fn sockscap_start(
    state: State<'_, AppState>,
    profiles: Vec<RoutingProfileDraft>,
) -> Result<EngineStatus, String> {
    state.sockscap.start(&profiles)
}

/// Stop the engine and (in later phases) revoke capture rules.
#[tauri::command]
pub fn sockscap_stop(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    state.sockscap.stop()
}

/// One-click recovery: clear leftover capture state if any.
#[tauri::command]
pub fn sockscap_recover(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    state.sockscap.recover()
}

/// Placeholder for the independent Sockscap window (Phase 4).
///
/// Returning a clear error keeps the IPC surface stable for frontend stubs
/// without implementing window creation in Phase 0.
#[tauri::command]
pub fn sockscap_open_window() -> Result<(), String> {
    Err(
        "sockscap_open_window is not implemented yet (Phase 4: independent Sockscap window)"
            .into(),
    )
}

/// Expose engine type construction for AppState wiring / tests.
pub fn new_engine() -> SockscapEngine {
    SockscapEngine::new()
}
