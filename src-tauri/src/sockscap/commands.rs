//! Tauri commands and event boundary for Sockscap.
//!
//! All mutable inputs are revalidated in Rust. Saved profiles/rule sources are
//! read from the standalone Sockscap store, saved Proxy/SSH sessions come from
//! the main database, and credential material never crosses IPC.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use super::capabilities::probe_capabilities;
use super::egress::{
    EgressIssue, EgressSessionAvailability, EgressSessionSummary, build_egress_runtime,
    inspect_egress_session, list_egress_sessions,
};
use super::flow::connectors::{EgressMetadata, EgressTarget};
use super::policy::rules::normalize_hostname;
use super::policy::{
    GFWLIST_OFFICIAL_SOURCE_ID, ParseReport, RefreshOutcome, RuleSourceKind, RuleSourceState,
    TestTargetRequest, TestTargetResult, build_cached_profile_matchers, compile_gfwlist_payload,
    ingest_payload, load_source_state, official_gfwlist_mirrors, refresh_custom_url,
    refresh_official_gfwlist, test_target, validate_source_id,
};
use super::preflight::{PreflightReport, run_preflight};
use super::processes::{ProcessCatalog, list_processes};
use super::storage::{
    PersistedRoutingProfile, PersistedRuleSource, RuleSourceDraft, StatsSnapshot,
    StatsSnapshotQuery, StatsTotals,
};
use super::types::{
    CapabilitiesReport, EgressKind, EngineStatus, RoutingProfileDraft, SshPoolOptions,
};
use crate::state::AppState;
use crate::terminal::hostkey::canonical_host;
use crate::terminal::ssh_pool::SshPoolSnapshot;

pub const STATUS_EVENT: &str = "sockscap://status";
pub const TRAFFIC_SUMMARY_EVENT: &str = "sockscap://traffic-summary";
pub const PROFILE_HEALTH_EVENT: &str = "sockscap://profile-health";
pub const EGRESS_HEALTH_EVENT: &str = "sockscap://egress-health";
pub const ALERT_EVENT: &str = "sockscap://alert";

/// Probe host capabilities without mutating system network state.
#[tauri::command]
pub fn sockscap_capabilities() -> CapabilitiesReport {
    probe_capabilities()
}

/// Return the current engine status, including startup recovery state.
#[tauri::command]
pub fn sockscap_status(state: State<'_, AppState>) -> EngineStatus {
    state.sockscap.status()
}

/// Run preflight against saved profiles only. Caller-supplied drafts are never
/// accepted as a start/configuration source.
#[tauri::command]
pub fn sockscap_preflight(state: State<'_, AppState>) -> Result<PreflightReport, String> {
    let profiles = state
        .sockscap_store
        .list_profiles()?
        .into_iter()
        .map(|record| record.profile)
        .collect::<Vec<_>>();
    Ok(run_preflight(&profiles))
}

#[tauri::command]
pub fn sockscap_list_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<PersistedRoutingProfile>, String> {
    state.sockscap_store.list_profiles()
}

#[tauri::command]
pub fn sockscap_upsert_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: RoutingProfileDraft,
    expected_revision: Option<u64>,
) -> Result<PersistedRoutingProfile, String> {
    let egress_health = validate_profile_egress(&state, &profile)?;
    let saved = state
        .sockscap_store
        .upsert_profile(&profile, expected_revision)?;
    emit_best_effort(
        &app,
        PROFILE_HEALTH_EVENT,
        ProfileHealthEvent {
            profile_id: saved.profile.id.clone(),
            enabled: saved.profile.enabled,
            egress: egress_health,
            issue: None,
        },
    );
    Ok(saved)
}

#[tauri::command]
pub fn sockscap_delete_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    expected_revision: Option<u64>,
) -> Result<(), String> {
    state
        .sockscap_store
        .delete_profile(&profile_id, expected_revision)?;
    emit_best_effort(
        &app,
        PROFILE_HEALTH_EVENT,
        ProfileHealthEvent {
            profile_id,
            enabled: false,
            egress: None,
            issue: Some(EgressIssue {
                code: "PROFILE_DELETED".into(),
                message: "routing profile was deleted".into(),
                user_action_required: false,
            }),
        },
    );
    Ok(())
}

/// Enumerate processes off the command thread. The catalog itself is bounded
/// and does not collect command lines or environment variables.
#[tauri::command]
pub async fn sockscap_list_processes() -> Result<ProcessCatalog, String> {
    tokio::task::spawn_blocking(list_processes)
        .await
        .map_err(|error| format!("PROCESS_CATALOG_TASK_FAILED: {error}"))?
}

/// Attempt to start from an immutable snapshot of saved configuration.
#[tauri::command]
pub fn sockscap_start(app: AppHandle, state: State<'_, AppState>) -> Result<EngineStatus, String> {
    let result = state.sockscap.start();
    publish_engine_result(&app, &state, &result);
    result
}

#[tauri::command]
pub fn sockscap_stop(app: AppHandle, state: State<'_, AppState>) -> Result<EngineStatus, String> {
    let result = state.sockscap.stop();
    publish_engine_result(&app, &state, &result);
    result
}

#[tauri::command]
pub fn sockscap_recover(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<EngineStatus, String> {
    let result = state.sockscap.recover();
    publish_engine_result(&app, &state, &result);
    result
}

/// Placeholder until the independent window lands in Phase 4.
#[tauri::command]
pub fn sockscap_open_window() -> Result<(), String> {
    Err("SOCKSCAP_WINDOW_NOT_READY: independent Sockscap window is not implemented yet".into())
}

#[tauri::command]
pub fn sockscap_list_egress_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<EgressSessionSummary>, String> {
    let db = state.db.lock().map_err(|_| {
        "SESSION_DATABASE_UNAVAILABLE: session database lock is poisoned".to_string()
    })?;
    list_egress_sessions(&db, &state.vault)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestEgressRequest {
    pub session_id: String,
    pub target_host: String,
    pub target_port: u16,
    #[serde(default = "default_egress_timeout_millis")]
    pub timeout_millis: u64,
    #[serde(default)]
    pub interactive: bool,
    #[serde(default)]
    pub ssh_pool_options: SshPoolOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestEgressResult {
    pub ok: bool,
    pub summary: EgressSessionSummary,
    pub elapsed_millis: u64,
    pub metadata: Option<EgressMetadata>,
    pub issue: Option<EgressIssue>,
    pub ssh_pool: Option<SshPoolSnapshot>,
}

#[tauri::command]
pub async fn sockscap_test_egress(
    app: AppHandle,
    state: State<'_, AppState>,
    request: TestEgressRequest,
) -> Result<TestEgressResult, String> {
    let target_host = validate_target_host(&request.target_host, request.target_port)?;
    if !(100..=300_000).contains(&request.timeout_millis) {
        return Err(
            "EGRESS_TEST_TIMEOUT_INVALID: timeoutMillis must be between 100 and 300000".into(),
        );
    }
    let started = Instant::now();
    let (mut summary, runtime) = {
        let db = state.db.lock().map_err(|_| {
            "SESSION_DATABASE_UNAVAILABLE: session database lock is poisoned".to_string()
        })?;
        let summary = inspect_egress_session(&db, &state.vault, &request.session_id)
            .map_err(|error| error.to_string())?;
        // Construct an interactive responder only after the persisted session
        // id passed Rust-side validation. This keeps caller-controlled values
        // out of native prompt correlation ids on rejected requests.
        let prompter = request.interactive.then(|| {
            crate::terminal::build_kbd_prompter(
                app.clone(),
                Arc::clone(&state.ssh_auth_responders),
                format!("sockscap-egress-{}", request.session_id),
            )
        });
        let runtime = build_egress_runtime(
            &db,
            Arc::clone(&state.vault),
            &request.session_id,
            &request.ssh_pool_options,
            prompter,
        );
        (summary, runtime)
    };
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(error) => {
            let issue = error.issue();
            summary.availability = if issue.user_action_required {
                EgressSessionAvailability::UserActionRequired
            } else {
                EgressSessionAvailability::Invalid
            };
            summary.issue = Some(issue.clone());
            let result = TestEgressResult {
                ok: false,
                summary,
                elapsed_millis: elapsed_millis(started),
                metadata: None,
                issue: Some(issue),
                ssh_pool: None,
            };
            emit_best_effort(&app, EGRESS_HEALTH_EVENT, result.clone());
            return Ok(result);
        }
    };
    let probe = runtime
        .probe(
            &EgressTarget {
                host: target_host,
                port: request.target_port,
                ip: None,
            },
            Duration::from_millis(request.timeout_millis),
            CancellationToken::new(),
        )
        .await;
    let ssh_pool = runtime.ssh_snapshot();
    runtime.shutdown().await;
    let result = match probe {
        Ok(metadata) => TestEgressResult {
            ok: true,
            summary,
            elapsed_millis: elapsed_millis(started),
            metadata: Some(metadata),
            issue: None,
            ssh_pool,
        },
        Err(issue) => TestEgressResult {
            ok: false,
            summary,
            elapsed_millis: elapsed_millis(started),
            metadata: None,
            issue: Some(issue),
            ssh_pool,
        },
    };
    emit_best_effort(&app, EGRESS_HEALTH_EVENT, result.clone());
    Ok(result)
}

/// Explain one synthetic flow using saved profiles and last-good rule caches.
#[tauri::command]
pub fn sockscap_test_target(
    app: AppHandle,
    state: State<'_, AppState>,
    mut request: TestTargetRequest,
) -> Result<TestTargetResult, String> {
    validate_test_target_request(&mut request)?;
    request.profiles = state
        .sockscap_store
        .list_profiles()?
        .into_iter()
        .map(|record| record.profile)
        .collect();
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("APP_DATA_UNAVAILABLE: {error}"))?;
    let (matchers, cache_notes) = build_cached_profile_matchers(&app_data, &request.profiles);
    request.matchers = matchers;
    let mut result = test_target(request);
    result.notes.extend(cache_notes);
    Ok(result)
}

/// Compile AutoProxy/GFWList text without writing it.
#[tauri::command]
pub fn sockscap_compile_rules(source_id: String, payload: String) -> Result<ParseReport, String> {
    compile_gfwlist_payload(&source_id, &payload)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSourceView {
    pub record: PersistedRuleSource,
    pub state: Option<RuleSourceState>,
}

#[tauri::command]
pub fn sockscap_list_rule_sources(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<RuleSourceView>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("APP_DATA_UNAVAILABLE: {error}"))?;
    Ok(state
        .sockscap_store
        .list_rule_sources()?
        .into_iter()
        .map(|record| RuleSourceView {
            state: load_source_state(&app_data, &record.source.id).map(public_rule_source_state),
            record,
        })
        .collect())
}

#[tauri::command]
pub fn sockscap_upsert_rule_source(
    state: State<'_, AppState>,
    source: RuleSourceDraft,
    expected_revision: Option<u64>,
) -> Result<PersistedRuleSource, String> {
    state
        .sockscap_store
        .upsert_rule_source(&source, expected_revision)
}

#[tauri::command]
pub fn sockscap_delete_rule_source(
    state: State<'_, AppState>,
    source_id: String,
    expected_revision: Option<u64>,
) -> Result<(), String> {
    state
        .sockscap_store
        .delete_rule_source(&source_id, expected_revision)
}

/// Import a caller-provided payload into an already persisted custom/local
/// source. No caller-controlled filesystem path or provenance URL is accepted.
#[tauri::command]
pub async fn sockscap_import_rule_source(
    app: AppHandle,
    state: State<'_, AppState>,
    source_id: String,
    payload: String,
) -> Result<RefreshOutcome, String> {
    let source = find_rule_source(&state, &source_id)?;
    if source.source.kind == RuleSourceKind::GfwlistOfficial {
        return Err(
            "BUILTIN_RULE_SOURCE_READ_ONLY: refresh the official source instead of importing it"
                .into(),
        );
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("APP_DATA_UNAVAILABLE: {error}"))?;
    tokio::task::spawn_blocking(move || {
        let provenance = match source.source.kind {
            RuleSourceKind::CustomUrl => source.source.url.as_deref(),
            RuleSourceKind::LocalFile => None,
            RuleSourceKind::GfwlistOfficial => unreachable!(),
        };
        ingest_payload(
            &app_data,
            &source.source.id,
            source.source.kind,
            provenance,
            &payload,
        )
    })
    .await
    .map_err(|error| format!("RULE_SOURCE_IMPORT_TASK_FAILED: {error}"))
}

#[tauri::command]
pub async fn sockscap_refresh_rule_source(
    app: AppHandle,
    state: State<'_, AppState>,
    source_id: String,
) -> Result<RefreshOutcome, String> {
    let source = find_rule_source(&state, &source_id)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("APP_DATA_UNAVAILABLE: {error}"))?;
    tokio::task::spawn_blocking(move || match source.source.kind {
        RuleSourceKind::GfwlistOfficial => Ok(refresh_official_gfwlist(&app_data)),
        RuleSourceKind::CustomUrl => {
            let url = source.source.url.as_deref().ok_or_else(|| {
                "RULE_SOURCE_URL_MISSING: custom URL source has no URL".to_string()
            })?;
            Ok(refresh_custom_url(
                &app_data,
                &source.source.id,
                url,
            ))
        }
        RuleSourceKind::LocalFile => Err(
            "RULE_SOURCE_IMPORT_REQUIRED: local-file sources are updated by importing a selected file payload"
                .into(),
        ),
    })
    .await
    .map_err(|error| format!("RULE_SOURCE_REFRESH_TASK_FAILED: {error}"))?
}

#[tauri::command]
pub fn sockscap_stats_snapshot(
    state: State<'_, AppState>,
    query: StatsSnapshotQuery,
) -> Result<StatsSnapshot, String> {
    state.sockscap_store.stats_snapshot(&query)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearStatsResult {
    pub removed_rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrafficSummaryEvent {
    generated_at_unix: u64,
    totals: StatsTotals,
    cleared: bool,
}

#[tauri::command]
pub fn sockscap_clear_stats(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClearStatsResult, String> {
    let result = ClearStatsResult {
        removed_rows: state.sockscap_store.clear_stats()?,
    };
    emit_best_effort(
        &app,
        TRAFFIC_SUMMARY_EVENT,
        TrafficSummaryEvent {
            generated_at_unix: unix_now(),
            totals: StatsTotals::default(),
            cleared: true,
        },
    );
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
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
            .map(str::to_string)
            .collect(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileHealthEvent {
    profile_id: String,
    enabled: bool,
    egress: Option<EgressSessionSummary>,
    issue: Option<EgressIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SockscapAlert {
    code: String,
    message: String,
    severity: String,
    created_at_unix: u64,
}

fn validate_profile_egress(
    state: &State<'_, AppState>,
    profile: &RoutingProfileDraft,
) -> Result<Option<EgressSessionSummary>, String> {
    let (Some(expected_kind), Some(session_id)) =
        (profile.egress_kind, profile.egress_ref_id.as_deref())
    else {
        return Ok(None);
    };
    let summary = {
        let db = state.db.lock().map_err(|_| {
            "SESSION_DATABASE_UNAVAILABLE: session database lock is poisoned".to_string()
        })?;
        inspect_egress_session(&db, &state.vault, session_id).map_err(|error| error.to_string())?
    };
    if summary.kind != expected_kind {
        return Err(format!(
            "EGRESS_KIND_MISMATCH: profile expects {}, selected session provides {}",
            egress_kind_name(expected_kind),
            egress_kind_name(summary.kind)
        ));
    }
    if summary.availability == EgressSessionAvailability::Invalid {
        let issue = summary.issue.as_ref().ok_or_else(|| {
            "EGRESS_SESSION_INVALID: selected egress is invalid without an issue code".to_string()
        })?;
        return Err(format!("{}: {}", issue.code, issue.message));
    }
    Ok(Some(summary))
}

fn egress_kind_name(kind: EgressKind) -> &'static str {
    match kind {
        EgressKind::ProxySession => "proxy_session",
        EgressKind::SshJump => "ssh_jump",
    }
}

fn validate_target_host(host: &str, port: u16) -> Result<String, String> {
    canonical_host(host, port)
        .map_err(|_| "EGRESS_TEST_TARGET_INVALID: target host or port is invalid".to_string())
}

fn validate_test_target_request(request: &mut TestTargetRequest) -> Result<(), String> {
    if request.port == 0 {
        return Err("TEST_TARGET_INVALID: port must be non-zero".into());
    }
    request.protocol = request.protocol.trim().to_ascii_lowercase();
    if !matches!(request.protocol.as_str(), "tcp" | "udp" | "quic") {
        return Err("TEST_TARGET_INVALID: protocol must be tcp, udp, or quic".into());
    }
    if request.pid.is_some() != request.process_start_time.is_some()
        || request.pid == Some(0)
        || request.process_start_time == Some(0)
    {
        return Err(
            "TEST_TARGET_INVALID: PID and non-zero processStartTime must be supplied together"
                .into(),
        );
    }
    if let Some(identity) = request.app_identity.as_mut() {
        *identity = identity.trim().to_string();
        if identity.is_empty() || identity.len() > 4096 || identity.chars().any(char::is_control) {
            return Err("TEST_TARGET_INVALID: application identity is invalid".into());
        }
    }
    if let Some(hostname) = request.hostname.as_mut() {
        let raw = hostname.trim();
        *hostname = if let Ok(address) = raw.parse::<IpAddr>() {
            address.to_string()
        } else {
            normalize_hostname(raw)
                .ok_or_else(|| "TEST_TARGET_INVALID: hostname is invalid".to_string())?
        };
    }
    if let Some(ip) = request.ip.as_mut() {
        *ip = ip
            .trim()
            .parse::<IpAddr>()
            .map_err(|_| "TEST_TARGET_INVALID: IP address is invalid".to_string())?
            .to_string();
    }
    if request.hostname.is_none() && request.ip.is_none() {
        return Err("TEST_TARGET_INVALID: hostname or IP address is required".into());
    }
    Ok(())
}

fn find_rule_source(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<PersistedRuleSource, String> {
    validate_source_id(source_id)?;
    state
        .sockscap_store
        .list_rule_sources()?
        .into_iter()
        .find(|record| record.source.id == source_id)
        .ok_or_else(|| format!("RULE_SOURCE_NOT_FOUND: rule source '{source_id}' does not exist"))
}

fn publish_engine_result(
    app: &AppHandle,
    state: &State<'_, AppState>,
    result: &Result<EngineStatus, String>,
) {
    let status = result
        .as_ref()
        .cloned()
        .unwrap_or_else(|_| state.sockscap.status());
    emit_best_effort(app, STATUS_EVENT, status);
    if let Err(error) = result {
        emit_alert(app, error);
    }
}

fn emit_alert(app: &AppHandle, error: &str) {
    let code = error
        .split_once(':')
        .map(|(code, _)| code)
        .unwrap_or("SOCKSCAP_ERROR")
        .chars()
        .filter(|character| character.is_ascii_uppercase() || *character == '_')
        .take(128)
        .collect::<String>();
    let message = error
        .chars()
        .filter(|character| !character.is_control())
        .take(1024)
        .collect::<String>();
    emit_best_effort(
        app,
        ALERT_EVENT,
        SockscapAlert {
            code: if code.is_empty() {
                "SOCKSCAP_ERROR".into()
            } else {
                code
            },
            message,
            severity: "error".into(),
            created_at_unix: unix_now(),
        },
    );
}

fn emit_best_effort<T>(app: &AppHandle, event: &str, payload: T)
where
    T: Serialize + Clone,
{
    if let Err(error) = app.emit(event, payload) {
        tracing::warn!(event, %error, "could not emit Sockscap event");
    }
}

fn default_egress_timeout_millis() -> u64 {
    15_000
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn public_rule_source_state(mut state: RuleSourceState) -> RuleSourceState {
    // The cache location is an internal implementation detail. In particular,
    // it must not be mistaken for a caller-authorized local import path.
    state.last_good_path = None;
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractEvents {
        traffic_summary: TrafficSummaryEvent,
        profile_health: ProfileHealthEvent,
        egress_health: TestEgressResult,
        alert: SockscapAlert,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractFixture {
        capabilities: CapabilitiesReport,
        status: EngineStatus,
        preflight: PreflightReport,
        profile: PersistedRoutingProfile,
        process_catalog: ProcessCatalog,
        egress_session: EgressSessionSummary,
        egress_test: TestEgressResult,
        rule_source: RuleSourceView,
        refresh_outcome: RefreshOutcome,
        target_result: TestTargetResult,
        stats: StatsSnapshot,
        events: ContractEvents,
    }

    fn target_request() -> TestTargetRequest {
        TestTargetRequest {
            app_identity: None,
            app_selector_kind: None,
            pid: None,
            process_start_time: None,
            hostname: Some("BÜCHER.Example.".into()),
            ip: None,
            port: 443,
            protocol: "TCP".into(),
            hostname_source: None,
            hard_bypass: false,
            profiles: Vec::new(),
            matchers: Vec::new(),
        }
    }

    #[test]
    fn test_target_input_is_canonicalized_and_requires_pid_incarnation() {
        let mut request = target_request();
        validate_test_target_request(&mut request).expect("validate target");
        assert_eq!(request.hostname.as_deref(), Some("xn--bcher-kva.example"));
        assert_eq!(request.protocol, "tcp");

        request.pid = Some(42);
        assert!(validate_test_target_request(&mut request).is_err());
        request.process_start_time = Some(0);
        assert!(validate_test_target_request(&mut request).is_err());
        request.process_start_time = Some(123);
        assert!(validate_test_target_request(&mut request).is_ok());
    }

    #[test]
    fn egress_target_rejects_urls_and_zero_ports() {
        assert!(validate_target_host("https://example.com/path", 443).is_err());
        assert!(validate_target_host("example.com", 0).is_err());
        assert_eq!(
            validate_target_host("[2001:db8::1]", 443).as_deref(),
            Ok("2001:db8::1")
        );
    }

    #[test]
    fn alert_code_extraction_is_bounded_to_machine_characters() {
        let raw = "RECOVERY_HELPER_REQUIRED: details";
        let code = raw
            .split_once(':')
            .map(|(code, _)| code)
            .unwrap()
            .chars()
            .filter(|character| character.is_ascii_uppercase() || *character == '_')
            .collect::<String>();
        assert_eq!(code, "RECOVERY_HELPER_REQUIRED");
    }

    #[test]
    fn webview_cannot_inject_profiles_into_test_target_contract() {
        let request: TestTargetRequest = serde_json::from_value(serde_json::json!({
            "hostname": "example.com",
            "port": 443,
            "protocol": "tcp",
            "hardBypass": false,
            "profiles": "malicious caller-owned value"
        }))
        .expect("deserialize public test-target request");
        assert!(request.profiles.is_empty());
        let serialized = serde_json::to_value(request).expect("serialize request");
        assert!(serialized.get("profiles").is_none());
    }

    #[test]
    fn rule_source_view_hides_internal_cache_path() {
        let state = RuleSourceState {
            source_id: "custom".into(),
            kind: RuleSourceKind::CustomUrl,
            url: Some("https://example.com/list.txt".into()),
            last_good_path: Some("/private/app-data/sockscap/rules/custom.json".into()),
            last_success_unix: None,
            last_mirror: None,
            last_sha256: None,
            etag: None,
            last_modified: None,
            refresh_after_unix: None,
            last_error: None,
            parse_stats: None,
        };
        assert!(public_rule_source_state(state).last_good_path.is_none());
    }

    #[test]
    fn shared_typescript_contract_fixture_deserializes_at_the_rust_boundary() {
        let raw = include_str!("../../../src/test/fixtures/sockscap-ipc-contract.json");
        let fixture: ContractFixture =
            serde_json::from_str(raw).expect("deserialize shared Sockscap IPC fixture");

        assert_eq!(
            fixture.capabilities.platform,
            super::super::types::CapturePlatform::Linux
        );
        assert_eq!(
            fixture.status.state,
            super::super::types::EngineState::Active
        );
        assert!(fixture.preflight.ok);
        assert_eq!(fixture.profile.profile.id, "contract-profile");
        assert_eq!(fixture.process_catalog.processes[0].pid, 4242);
        assert_eq!(fixture.egress_session.id, "contract-ssh");
        assert!(fixture.egress_test.ok);
        assert_eq!(fixture.rule_source.record.source.id, "contract-source");
        assert!(
            fixture
                .rule_source
                .state
                .as_ref()
                .is_some_and(|state| state.last_good_path.is_none())
        );
        assert!(fixture.refresh_outcome.ok);
        assert_eq!(
            fixture.target_result.selected_profile_id.as_deref(),
            Some("contract-profile")
        );
        assert_eq!(fixture.stats.totals.connections, 2);
        assert!(!fixture.events.traffic_summary.cleared);
        assert!(fixture.events.profile_health.enabled);
        assert!(!fixture.events.egress_health.ok);
        assert_eq!(fixture.events.alert.code, "RECOVERY_REQUIRED");

        assert!(!raw.contains("\"username\""));
        assert!(!raw.contains("\"password\""));
        assert!(!raw.contains("privateKeyPath"));
    }
}
