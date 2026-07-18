//! Tauri commands for Sockscap Phase 0/1.
//!
//! Command surface follows design plan §12. Write commands re-validate on the
//! Rust side; capture install is not available yet.

use tauri::{Manager, State};
use serde::Serialize;

use super::capabilities::probe_capabilities;
use super::orchestrator::SockscapEngine;
use super::policy::{
    compile_gfwlist_payload, ingest_payload, official_gfwlist_mirrors, test_target,
    ParseReport, RefreshOutcome, RuleSourceKind, TestTargetRequest, TestTargetResult,
    GFWLIST_OFFICIAL_SOURCE_ID,
};
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

/// Explain how a synthetic target would be routed (design plan §12 test_target).
///
/// Phase 1: profiles are provided by the caller (no sockscap.db yet). Matchers
/// are synthesized from default/unknown actions unless a compiled snapshot is
/// supplied in-process by later phases.
#[tauri::command]
pub fn sockscap_test_target(request: TestTargetRequest) -> TestTargetResult {
    test_target(request)
}

/// Compile AutoProxy / GFWList text (or Base64) without network I/O.
#[tauri::command]
pub fn sockscap_compile_rules(source_id: String, payload: String) -> Result<ParseReport, String> {
    compile_gfwlist_payload(&source_id, &payload)
}

/// Ingest a rule payload into last-good storage under the app data directory.
#[tauri::command]
pub fn sockscap_ingest_rule_source(
    app: tauri::AppHandle,
    source_id: String,
    kind: RuleSourceKind,
    mirror: Option<String>,
    payload: String,
) -> Result<RefreshOutcome, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(ingest_payload(
        &app_data,
        &source_id,
        kind,
        mirror.as_deref(),
        &payload,
    ))
}

/// Metadata about the built-in GFWList official source (mirrors, source id).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GfwlistOfficialInfo {
    pub source_id: String,
    pub mirrors: Vec<String>,
}

#[tauri::command]
pub fn sockscap_gfwlist_official_info() -> GfwlistOfficialInfo {
    GfwlistOfficialInfo {
        source_id: GFWLIST_OFFICIAL_SOURCE_ID.to_string(),
        mirrors: official_gfwlist_mirrors()
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
    }
}

/// Expose engine type construction for AppState wiring / tests.
pub fn new_engine() -> SockscapEngine {
    SockscapEngine::new()
}
