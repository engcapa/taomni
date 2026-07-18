//! Tauri commands for Sockscap Phase 0–3.
//!
//! Command surface follows design plan §12. Write commands re-validate on the
//! Rust side; capture install is not available yet.

use serde::Serialize;
use tauri::{Manager, State};

use super::capabilities::probe_capabilities;
use super::db::{
    self, clear_recovery_journal, delete_profile, list_profiles, read_recovery_journal,
    upsert_profile, RecoveryJournal,
};
use super::flow::runtime::{
    clear_global_runtime, compile_subscription_rules, set_global_runtime, FlowRuntime,
};
use super::orchestrator::SockscapEngine;
use super::policy::gfwlist::{load_last_good_text, GFWLIST_OFFICIAL_SOURCE_ID};
use crate::proxy::resolve_session_proxy_with_db;
use super::policy::{
    compile_gfwlist_payload, ingest_payload, official_gfwlist_mirrors, test_target, ParseReport,
    RefreshOutcome, RuleSourceKind, TestTargetRequest, TestTargetResult,
};
use super::preflight::{run_preflight, PreflightReport};
use super::types::{
    detect_profile_conflicts, CapabilitiesReport, EngineStatus, RoutingProfileDraft,
};
use crate::state::AppState;

fn lock_sockscap_db<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state
        .sockscap_db
        .lock()
        .map_err(|_| "sockscap database lock poisoned".to_string())
}

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
/// When `profiles` is omitted, loads enabled drafts from sockscap.db.
#[tauri::command]
pub fn sockscap_preflight(
    state: State<'_, AppState>,
    profiles: Option<Vec<RoutingProfileDraft>>,
) -> Result<PreflightReport, String> {
    let profiles = match profiles {
        Some(p) => p,
        None => {
            let db = lock_sockscap_db(&state)?;
            list_profiles(&db).map_err(|e| format!("list profiles: {e}"))?
        }
    };
    Ok(run_preflight(&profiles))
}

/// Attempt to start the engine. Phase 0 always fails preflight (capture not
/// implemented) but exercises the full start error path and recovery journal.
fn build_runtime_for(
    state: &State<'_, AppState>,
    profiles: &[RoutingProfileDraft],
    app_data: &std::path::Path,
) -> FlowRuntime {
    let (sub_direct, sub_proxy) =
        if let Some(text) = load_last_good_text(app_data, GFWLIST_OFFICIAL_SOURCE_ID) {
            compile_subscription_rules(GFWLIST_OFFICIAL_SOURCE_ID, &text)
        } else {
            (Vec::new(), Vec::new())
        };
    let vault = state.vault.clone();
    let resolve = |id: &str| -> Option<crate::proxy::ResolvedProxy> {
        let db = state.db.lock().ok()?;
        resolve_session_proxy_with_db(&db, &vault, id).ok().flatten()
    };
    let mut bypass = vec![
        "127.0.0.1".into(),
        "::1".into(),
        "localhost".into(),
    ];
    // Collect proxy hosts for hard bypass.
    for p in profiles.iter().filter(|p| p.enabled) {
        if matches!(p.egress_kind, Some(crate::sockscap::types::EgressKind::ProxySession)) {
            if let Some(id) = p.egress_ref_id.as_deref() {
                if let Some(px) = resolve(id) {
                    bypass.push(px.host);
                }
            }
        }
    }
    FlowRuntime::from_profiles(profiles, &sub_direct, &sub_proxy, &resolve, &bypass)
}

#[tauri::command]
pub fn sockscap_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profiles: Option<Vec<RoutingProfileDraft>>,
) -> Result<EngineStatus, String> {
    let profiles = match profiles {
        Some(p) => p,
        None => {
            let db = lock_sockscap_db(&state)?;
            list_profiles(&db).map_err(|e| format!("list profiles: {e}"))?
        }
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    set_global_runtime(build_runtime_for(&state, &profiles, &app_data));
    {
        let db = lock_sockscap_db(&state)?;
        let _ = db::write_recovery_journal(&db, "preparing", "Preparing", None);
    }
    match state.sockscap.start(&profiles) {
        Ok(status) => {
            let db = lock_sockscap_db(&state)?;
            let _ = db::write_recovery_journal(&db, "active", "Active", None);
            Ok(status)
        }
        Err(e) => {
            clear_global_runtime();
            let db = lock_sockscap_db(&state)?;
            let _ = clear_recovery_journal(&db);
            Err(e)
        }
    }
}

/// Stop the engine and clear the recovery marker (Phase 0 has no rules to tear down).
#[tauri::command]
pub fn sockscap_stop(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    let status = state.sockscap.stop()?;
    clear_global_runtime();
    let db = lock_sockscap_db(&state)?;
    let _ = clear_recovery_journal(&db);
    Ok(status)
}

/// One-click recovery: clear leftover capture state if any.
#[tauri::command]
pub fn sockscap_recover(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    let status = state.sockscap.recover()?;
    clear_global_runtime();
    let db = lock_sockscap_db(&state)?;
    let _ = clear_recovery_journal(&db);
    Ok(status)
}

/// Open or focus the independent Sockscap window (`#sockscap=main`).
#[tauri::command]
pub async fn sockscap_open_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    crate::windowing::open_detached_window(
        app_handle,
        "sockscap".into(),
        "main".into(),
        Some("Sockscap".into()),
        None,
        None,
        Some(1100.0),
        Some(760.0),
    )
    .await
}

/// Explain how a synthetic target would be routed (design plan §12 test_target).
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

// --- Profile CRUD (Phase 3) -------------------------------------------------

#[tauri::command]
pub fn sockscap_list_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<RoutingProfileDraft>, String> {
    let db = lock_sockscap_db(&state)?;
    list_profiles(&db).map_err(|e| format!("list profiles: {e}"))
}

#[tauri::command]
pub fn sockscap_upsert_profile(
    state: State<'_, AppState>,
    profile: RoutingProfileDraft,
) -> Result<RoutingProfileDraft, String> {
    if profile.id.trim().is_empty() {
        return Err("profile id is required".into());
    }
    if profile.name.trim().is_empty() {
        return Err("profile name is required".into());
    }
    let db = lock_sockscap_db(&state)?;
    let mut existing = list_profiles(&db).map_err(|e| format!("list profiles: {e}"))?;
    if let Some(pos) = existing.iter().position(|p| p.id == profile.id) {
        existing[pos] = profile.clone();
    } else {
        existing.push(profile.clone());
    }
    let conflicts = detect_profile_conflicts(&existing);
    if !conflicts.is_empty() {
        let msg = conflicts
            .iter()
            .map(|c| format!("{} vs {}: {}", c.profile_a, c.profile_b, c.reason))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("profile conflict: {msg}"));
    }
    upsert_profile(&db, &profile).map_err(|e| format!("upsert profile: {e}"))?;
    Ok(profile)
}

#[tauri::command]
pub fn sockscap_delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("profile id is required".into());
    }
    let db = lock_sockscap_db(&state)?;
    delete_profile(&db, &id).map_err(|e| format!("delete profile: {e}"))
}

#[tauri::command]
pub fn sockscap_recovery_journal(
    state: State<'_, AppState>,
) -> Result<Option<RecoveryJournal>, String> {
    let db = lock_sockscap_db(&state)?;
    read_recovery_journal(&db).map_err(|e| format!("read recovery journal: {e}"))
}


/// Tray icon / menu presentation for the current engine state (Phase 8).
#[tauri::command]
pub fn sockscap_tray_presentation(state: State<'_, AppState>) -> super::tray::TrayPresentation {
    let status = state.sockscap.status();
    super::tray::tray_presentation(status.state, &status.message)
}

/// Expose engine type construction for AppState wiring / tests.
pub fn new_engine() -> SockscapEngine {
    SockscapEngine::new()
}
