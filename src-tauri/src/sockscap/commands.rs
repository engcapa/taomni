//! Tauri command + event surface for Sockscap (plan §12).
//!
//! Every write command re-validates on the Rust side and never trusts the
//! webview's paths / PIDs / URLs / ports. Real privileged operations go through
//! the capture adapter / helper, not these commands. Events use the
//! `sockscap://…` namespace.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::attribution::{attribute, AttributionInputs};
use super::capability::{self, Capabilities};
use super::conflict::validate_upsert;
use super::db;
use super::download::{self, DownloadLimits};
use super::engine::EngineState;
use super::flow::StatsSnapshot;
use super::model::{CustomRule, RoutingProfile, RuleSource, RuleSourceKind};
use super::policy::{select_profile, AppIdentity, DecisionReason, FlowTarget, HardBypass};
use super::runtime::{compile_profile, RuleSourceMeta, SockscapState};
use super::{Action, Protocol};
use crate::state::AppState;

/// Event channel names (plan §12).
pub const EVT_STATUS: &str = "sockscap://status";
pub const EVT_TRAFFIC_SUMMARY: &str = "sockscap://traffic-summary";
pub const EVT_PROFILE_HEALTH: &str = "sockscap://profile-health";
pub const EVT_EGRESS_HEALTH: &str = "sockscap://egress-health";
pub const EVT_ALERT: &str = "sockscap://alert";

/// Engine status returned by `sockscap_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SockscapStatus {
    pub state: EngineState,
    pub capabilities: Capabilities,
}

/// A running process for the picker (`sockscap_list_processes`).
///
/// `process_start_time` is an opaque token captured at list time and persisted
/// with runtime-process selectors so a recycled PID cannot silently match a
/// different process (plan §5, §16.4-17). `path` is best-effort (often empty
/// without elevation) and used by "Remember as application".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_start_time: Option<String>,
}

/// An egress session candidate (Proxy or SSH) from the main session DB.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressSession {
    pub id: String,
    pub name: String,
    pub kind: String,
}

/// The app identity part of a `sockscap_test_target` request.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestAppInput {
    pub windows_exe: Option<String>,
    pub macos_signing_id: Option<String>,
    pub macos_app_path: Option<String>,
    pub linux_path: Option<String>,
    pub linux_cgroup: Option<String>,
    pub pid: Option<u32>,
    pub process_start_time: Option<String>,
}

/// A `sockscap_test_target` request (plan §6.3 test-target).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTargetInput {
    #[serde(default)]
    pub app: TestAppInput,
    pub host: Option<String>,
    pub ip: Option<String>,
    pub port: u16,
    /// "tcp" | "udp" | "icmp" | "other".
    #[serde(default = "default_tcp")]
    pub protocol: String,
}

fn default_tcp() -> String {
    "tcp".into()
}

/// The explained decision returned by `sockscap_test_target`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTargetResult {
    pub profile_id: Option<String>,
    pub action: Action,
    pub reason: String,
    pub hostname_source: String,
    pub matched_source_id: Option<String>,
    pub matched_pattern: Option<String>,
    pub note: Option<String>,
}

fn build_app_identity(input: &TestAppInput) -> AppIdentity {
    AppIdentity {
        windows_exe: input.windows_exe.clone(),
        macos_signing_id: input.macos_signing_id.clone(),
        macos_app_path: input.macos_app_path.clone(),
        linux_path: input.linux_path.clone(),
        linux_cgroup: input.linux_cgroup.clone(),
        pid: input.pid,
        process_start_time: input.process_start_time.clone(),
    }
}

fn parse_protocol(s: &str) -> Protocol {
    match s {
        "udp" => Protocol::Udp,
        "icmp" => Protocol::Icmp,
        "tcp" => Protocol::Tcp,
        _ => Protocol::Other,
    }
}

fn reason_str(r: DecisionReason) -> &'static str {
    match r {
        DecisionReason::HardBypass => "hard-bypass",
        DecisionReason::CustomRule => "custom-rule",
        DecisionReason::LocalNetwork => "local-network",
        DecisionReason::SubscriptionException => "subscription-exception",
        DecisionReason::SubscriptionProxy => "subscription-proxy",
        DecisionReason::UnknownDomainAction => "unknown-domain-action",
        DecisionReason::DefaultAction => "default-action",
        DecisionReason::ProtocolPolicy => "protocol-policy",
    }
}

/// Parse Windows `tasklist /fo csv /nh` output into processes.
pub fn parse_tasklist_csv(out: &str) -> Vec<ProcessInfo> {
    let mut v = Vec::new();
    for line in out.lines() {
        let fields: Vec<&str> = line.split("\",\"").collect();
        if fields.len() < 2 {
            continue;
        }
        let name = fields[0].trim_matches('"').to_string();
        let pid = fields[1].trim_matches('"').trim().parse::<u32>();
        if let Ok(pid) = pid {
            if !name.is_empty() {
                // tasklist has no creation time; use a stable opaque token so a
                // selector saved from this listing still has a non-empty stamp.
                let process_start_time = Some(format!("tasklist:{pid}:{name}"));
                v.push(ProcessInfo {
                    pid,
                    name,
                    path: None,
                    process_start_time,
                });
            }
        }
    }
    v
}

/// Parse Unix `ps -eo pid=,lstart=,comm=` (or plain `pid=,comm=`) output.
pub fn parse_ps(out: &str) -> Vec<ProcessInfo> {
    let mut v = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(pid_s) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_s.parse::<u32>() else {
            continue;
        };
        // With `lstart` the middle is "Day Mon DD HH:MM:SS YYYY" (5 fields), then comm.
        // Without it, the rest is just the command name.
        let rest: Vec<&str> = parts.collect();
        if rest.is_empty() {
            continue;
        }
        let (name, process_start_time) = if rest.len() >= 6 {
            // lstart present: first 5 tokens are the start time.
            let start = rest[..5].join(" ");
            let name = rest[5..].join(" ");
            (name, Some(start))
        } else {
            let name = rest.join(" ");
            (name.clone(), Some(format!("ps:{pid}:{name}")))
        };
        if name.is_empty() {
            continue;
        }
        v.push(ProcessInfo {
            pid,
            name,
            path: None,
            process_start_time,
        });
    }
    v
}

/// Parse PowerShell `ConvertTo-Csv` of Id,ProcessName,Path,StartTime.
pub fn parse_powershell_process_csv(out: &str) -> Vec<ProcessInfo> {
    let mut v = Vec::new();
    for (i, line) in out.lines().enumerate() {
        // Skip header row.
        if i == 0 && line.to_ascii_lowercase().contains("processname") {
            continue;
        }
        let fields = split_csv_line(line);
        if fields.len() < 2 {
            continue;
        }
        let Ok(pid) = fields[0].trim().parse::<u32>() else {
            continue;
        };
        let name = fields[1].trim().to_string();
        if name.is_empty() {
            continue;
        }
        let path = fields
            .get(2)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let process_start_time = fields
            .get(3)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| Some(format!("ps1:{pid}:{name}")));
        v.push(ProcessInfo {
            pid,
            name,
            path,
            process_start_time,
        });
    }
    v
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                fields.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    fields.push(cur);
    fields
}

/* -------------------------------- commands -------------------------------- */

/// Open (or focus) the standalone Sockscap window. The window is created on the
/// Rust side — like the SFTP/notes detached windows — because the main webview
/// isn't granted the ACL permission to create windows itself. Available even if
/// the module failed to initialize, so it never depends on `SockscapState`.
#[tauri::command]
pub fn sockscap_open_window(app: AppHandle) -> Result<(), String> {
    super::tray::open_window(&app);
    Ok(())
}

#[tauri::command]
pub fn sockscap_capabilities() -> Capabilities {
    capability::detect()
}

#[tauri::command]
pub fn sockscap_status(state: State<'_, SockscapState>) -> SockscapStatus {
    SockscapStatus {
        state: state.orchestrator.state(),
        capabilities: capability::detect(),
    }
}

#[tauri::command]
pub fn sockscap_list_profiles(state: State<'_, SockscapState>) -> Result<Vec<RoutingProfile>, String> {
    let conn = state.conn.lock().unwrap();
    db::list_profiles(&conn).map_err(|e| e.to_string())
}

/// Insert/replace a profile after re-validating conflicts on the Rust side
/// (plan §5 — same-priority overlap / multiple globals are rejected with an
/// explanation).
#[tauri::command]
pub fn sockscap_upsert_profile(
    state: State<'_, SockscapState>,
    profile: RoutingProfile,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let existing = db::list_profiles(&conn).map_err(|e| e.to_string())?;
    validate_upsert(&existing, &profile)?;
    db::upsert_profile(&conn, &profile).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sockscap_delete_profile(
    state: State<'_, SockscapState>,
    id: String,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::delete_profile(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sockscap_get_custom_rules(
    state: State<'_, SockscapState>,
    profile_id: String,
) -> Result<Vec<CustomRule>, String> {
    let conn = state.conn.lock().unwrap();
    db::list_custom_rules(&conn, &profile_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sockscap_set_custom_rules(
    state: State<'_, SockscapState>,
    profile_id: String,
    rules: Vec<CustomRule>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::replace_custom_rules(&conn, &profile_id, &rules).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sockscap_list_rule_sources(
    state: State<'_, SockscapState>,
) -> Result<Vec<RuleSource>, String> {
    let conn = state.conn.lock().unwrap();
    db::list_rule_sources(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sockscap_upsert_rule_source(
    state: State<'_, SockscapState>,
    source: RuleSource,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::upsert_rule_source(&conn, &source).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sockscap_delete_rule_source(
    state: State<'_, SockscapState>,
    id: String,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::delete_rule_source(&conn, &id).map_err(|e| e.to_string())
}

/// The metadata view returned after a refresh/import (UI shows counts, mirror,
/// last-good time, unsupported examples — plan §6.2).
fn meta_from_snapshot(snap: &download::CompiledSnapshot) -> RuleSourceMeta {
    RuleSourceMeta {
        stats: Some((&snap.stats).into()),
        sha256: Some(snap.sha256.clone()),
        mirror_url: Some(snap.mirror_url.clone()),
        last_good_at: Some(snap.last_good_at),
        last_error: None,
        unsupported_examples: snap
            .unsupported_examples
            .iter()
            .map(|u| format!("{} ({})", u.original, u.reason))
            .collect(),
    }
}

/// Download a rule source from its healthy mirrors, compile it, and cache the
/// last-good snapshot. A failed update keeps the previous last-good (plan
/// §6.2/§16.3-12).
#[tauri::command]
pub async fn sockscap_refresh_rule_source(
    state: State<'_, SockscapState>,
    id: String,
) -> Result<RuleSourceMeta, String> {
    // Resolve the source's mirror list without holding the lock across await.
    let source = {
        let conn = state.conn.lock().unwrap();
        db::list_rule_sources(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("rule source '{id}' not found"))?
    };
    let urls = if source.urls.is_empty() && matches!(source.kind, RuleSourceKind::GfwlistOfficial) {
        download::GFWLIST_MIRRORS.iter().map(|s| s.to_string()).collect()
    } else {
        source.urls.clone()
    };

    let fetched = download::fetch_first_healthy(&urls, &DownloadLimits::default(), None).await;
    let raw = match fetched {
        Ok(Some(r)) => r,
        Ok(None) => {
            // 304 Not Modified — keep last-good.
            let cache = state.rule_cache.lock().unwrap();
            return Ok(cache.meta.get(&id).cloned().unwrap_or_default());
        }
        Err(e) => {
            let mut cache = state.rule_cache.lock().unwrap();
            cache.record_error(&id, e.to_string());
            return Err(e.to_string());
        }
    };
    let now = chrono::Utc::now().timestamp();
    match download::process_document(&id, &raw.bytes, &raw.url, now) {
        Ok(snap) => {
            let meta = meta_from_snapshot(&snap);
            let mut cache = state.rule_cache.lock().unwrap();
            cache.put(id.clone(), snap.compiled, meta.clone());
            Ok(meta)
        }
        Err(e) => {
            let mut cache = state.rule_cache.lock().unwrap();
            cache.record_error(&id, e.to_string());
            Err(e.to_string())
        }
    }
}

/// Import rule content directly (local file body or pasted list). Compiles and
/// caches it as the source's last-good.
#[tauri::command]
pub fn sockscap_import_rule_source(
    state: State<'_, SockscapState>,
    id: String,
    content: String,
) -> Result<RuleSourceMeta, String> {
    let now = chrono::Utc::now().timestamp();
    let snap = download::process_document(&id, content.as_bytes(), "local-import", now)?;
    let meta = meta_from_snapshot(&snap);
    let mut cache = state.rule_cache.lock().unwrap();
    cache.put(id, snap.compiled, meta.clone());
    Ok(meta)
}

/// Explain how a target would route: matched profile, rule source, rule text,
/// hostname source and final action (plan §6.3, §16.3-13).
#[tauri::command]
pub fn sockscap_test_target(
    state: State<'_, SockscapState>,
    input: TestTargetInput,
) -> Result<TestTargetResult, String> {
    let ip: Option<IpAddr> = input.ip.as_deref().and_then(|s| s.parse().ok());
    let (host, hostname_source) = attribute(&AttributionInputs {
        platform_hostname: input.host.clone(),
        has_ip: ip.is_some(),
        ..Default::default()
    });
    let target = FlowTarget {
        host: host.clone(),
        hostname_source,
        ip,
        port: input.port,
        protocol: parse_protocol(&input.protocol),
    };

    let conn = state.conn.lock().unwrap();
    let profiles = db::list_profiles(&conn).map_err(|e| e.to_string())?;
    let app = build_app_identity(&input.app);
    let selected = select_profile(&profiles, &app).cloned();
    let result = match selected {
        Some(p) => {
            let custom = db::list_custom_rules(&conn, &p.id).map_err(|e| e.to_string())?;
            drop(conn);
            let cache = state.rule_cache.lock().unwrap();
            let cp = compile_profile(p.clone(), &custom, &cache);
            let bypass = HardBypass::default();
            let d = cp.decide(&bypass, &target);
            TestTargetResult {
                profile_id: Some(p.id),
                action: d.action,
                reason: reason_str(d.reason).to_string(),
                hostname_source: d.hostname_source.as_str().to_string(),
                matched_source_id: d.matched_source_id,
                matched_pattern: d.matched_pattern,
                note: d.note,
            }
        }
        None => TestTargetResult {
            profile_id: None,
            action: Action::Direct,
            reason: "no-profile".to_string(),
            hostname_source: hostname_source.as_str().to_string(),
            matched_source_id: None,
            matched_pattern: None,
            note: Some("no profile applies — left direct/uncaptured".into()),
        },
    };
    Ok(result)
}

/// Start the engine using the persisted profiles (plan §9 start transaction).
/// On the current build the capture backend is absent, so this returns a clear
/// "backend not available" error and stays Disabled — never a fake Active.
#[tauri::command]
pub async fn sockscap_start(state: State<'_, SockscapState>) -> Result<EngineState, String> {
    state.start_engine().await
}

#[tauri::command]
pub async fn sockscap_stop(state: State<'_, SockscapState>) -> Result<EngineState, String> {
    state.stop_engine().await
}

/// One-click "restore network" — fail-open uninstall independent of upstream
/// availability (plan §9, §16.6-23).
#[tauri::command]
pub async fn sockscap_recover(state: State<'_, SockscapState>) -> Result<EngineState, String> {
    state.recover_engine().await
}

#[tauri::command]
pub fn sockscap_stats_snapshot(
    state: State<'_, SockscapState>,
) -> Result<db::TrafficTotals, String> {
    let conn = state.conn.lock().unwrap();
    db::query_traffic_totals(&conn, 0).map_err(|e| e.to_string())
}

/// Minute-resolution series for the Dashboard trend chart (plan §11 — default
/// last 30 minutes). `minutes` is clamped to 1..=24*60.
#[tauri::command]
pub fn sockscap_stats_series(
    state: State<'_, SockscapState>,
    minutes: Option<u32>,
) -> Result<Vec<db::TrafficMinutePoint>, String> {
    let window = minutes.unwrap_or(30).clamp(1, 24 * 60) as i64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Bucket timestamps are minute-aligned seconds.
    let since = now - window * 60;
    let conn = state.conn.lock().unwrap();
    db::query_traffic_series(&conn, since).map_err(|e| e.to_string())
}

/// Top domains by connections (plan §11). Empty when domain aggregates are off
/// or no data has been recorded.
#[tauri::command]
pub fn sockscap_top_domains(
    state: State<'_, SockscapState>,
    limit: Option<u32>,
) -> Result<Vec<db::DomainStatRow>, String> {
    let lim = limit.unwrap_or(10).clamp(1, 100) as i64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Day buckets use unix day start; query last 7 days of day_ts values.
    let since_day = now - 7 * 24 * 60 * 60;
    let conn = state.conn.lock().unwrap();
    db::query_top_domains(&conn, since_day, lim).map_err(|e| e.to_string())
}

/// Live in-memory counters (process lifetime) — complements the persisted
/// totals from `sockscap_stats_snapshot`.
#[tauri::command]
pub fn sockscap_live_stats(state: State<'_, SockscapState>) -> StatsSnapshot {
    state.orchestrator.stats.snapshot()
}

#[tauri::command]
pub fn sockscap_clear_stats(state: State<'_, SockscapState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::clear_stats(&conn).map_err(|e| e.to_string())
}

/// Hide the Sockscap window without destroying it (plan §9 hide-to-tray).
#[tauri::command]
pub fn sockscap_hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("sockscap") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Result of a lightweight egress preflight (plan §12 `sockscap_test_egress`).
/// Does not open a full SSH channel or send credentials over the wire beyond a
/// TCP connect to the session host:port — secrets stay in Vault.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressTestResult {
    pub ok: bool,
    pub session_id: String,
    pub kind: String,
    pub endpoint: String,
    pub latency_ms: Option<u64>,
    pub message: String,
}

/// TCP reachability preflight for a Proxy/SSH egress session (plan §11 egress
/// test). Full protocol handshake remains the engine's job at Start.
#[tauri::command]
pub async fn sockscap_test_egress(
    app_state: State<'_, AppState>,
    session_id: String,
) -> Result<EgressTestResult, String> {
    let (kind, host, port) = {
        let conn = app_state
            .db
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        let row = conn
            .query_row(
                "SELECT session_type, host, port FROM sessions WHERE id = ?1",
                rusqlite::params![session_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|_| format!("egress session not found: {session_id}"))?;
        row
    };
    let st = kind.to_ascii_lowercase();
    let kind_label = if st.contains("ssh") {
        "ssh"
    } else if st.contains("proxy") {
        "proxy"
    } else {
        return Err(format!("session {session_id} is not a Proxy/SSH egress candidate"));
    };
    if host.trim().is_empty() || port <= 0 || port > u16::MAX as i64 {
        return Ok(EgressTestResult {
            ok: false,
            session_id,
            kind: kind_label.into(),
            endpoint: format!("{host}:{port}"),
            latency_ms: None,
            message: "session host/port is incomplete".into(),
        });
    }
    let endpoint = format!("{host}:{port}");
    let addr = endpoint.clone();
    let started = std::time::Instant::now();
    let connect = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::TcpStream::connect(addr),
    )
    .await;
    match connect {
        Ok(Ok(_stream)) => Ok(EgressTestResult {
            ok: true,
            session_id,
            kind: kind_label.into(),
            endpoint,
            latency_ms: Some(started.elapsed().as_millis() as u64),
            message: format!("TCP connect ok ({kind_label})"),
        }),
        Ok(Err(e)) => Ok(EgressTestResult {
            ok: false,
            session_id,
            kind: kind_label.into(),
            endpoint,
            latency_ms: Some(started.elapsed().as_millis() as u64),
            message: format!("TCP connect failed: {e}"),
        }),
        Err(_) => Ok(EgressTestResult {
            ok: false,
            session_id,
            kind: kind_label.into(),
            endpoint,
            latency_ms: Some(5000),
            message: "TCP connect timed out after 5s".into(),
        }),
    }
}

/// List running processes for the picker. Runs the platform lister and parses
/// it; returns an empty list (not an error) if the lister is unavailable.
///
/// On Windows prefers PowerShell so we can surface executable path + start time
/// for "Remember as application" and PID-reuse protection; falls back to
/// `tasklist`. On Unix uses `ps` with `lstart` when available.
#[tauri::command]
pub fn sockscap_list_processes() -> Vec<ProcessInfo> {
    #[cfg(target_os = "windows")]
    {
        // Prefer richer listing; fall back to tasklist if PowerShell is locked down.
        let ps = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-Process | Select-Object Id,ProcessName,Path,StartTime | ConvertTo-Csv -NoTypeInformation",
            ])
            .output();
        if let Ok(o) = ps {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                let procs = parse_powershell_process_csv(&text);
                if !procs.is_empty() {
                    return procs;
                }
            }
        }
        match std::process::Command::new("tasklist")
            .args(["/fo", "csv", "/nh"])
            .output()
        {
            Ok(o) if o.status.success() => parse_tasklist_csv(&String::from_utf8_lossy(&o.stdout)),
            _ => {
                tracing::warn!("sockscap: process lister unavailable");
                Vec::new()
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let with_lstart = std::process::Command::new("ps")
            .args(["-eo", "pid=,lstart=,comm="])
            .output();
        if let Ok(o) = with_lstart {
            if o.status.success() {
                let procs = parse_ps(&String::from_utf8_lossy(&o.stdout));
                if !procs.is_empty() {
                    return procs;
                }
            }
        }
        match std::process::Command::new("ps")
            .args(["-eo", "pid=,comm="])
            .output()
        {
            Ok(o) if o.status.success() => parse_ps(&String::from_utf8_lossy(&o.stdout)),
            _ => {
                tracing::warn!("sockscap: process lister unavailable");
                Vec::new()
            }
        }
    }
}

/// List Proxy/SSH sessions from the main session DB as egress candidates. Only
/// id/name/kind — never credentials (plan §4.3, §10).
#[tauri::command]
pub fn sockscap_list_egress_sessions(
    app_state: State<'_, AppState>,
) -> Result<Vec<EgressSession>, String> {
    let conn = app_state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, session_type FROM sessions")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let (id, name, stype) = r.map_err(|e| e.to_string())?;
        let s = stype.to_ascii_lowercase();
        let kind = if s.contains("ssh") {
            "ssh"
        } else if s.contains("proxy") {
            "proxy"
        } else {
            continue;
        };
        out.push(EgressSession {
            id,
            name,
            kind: kind.to_string(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tasklist_csv() {
        let out = "\"chrome.exe\",\"1234\",\"Console\",\"1\",\"123,456 K\"\n\
                   \"svchost.exe\",\"56\",\"Services\",\"0\",\"8,000 K\"";
        let procs = parse_tasklist_csv(out);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].name, "chrome.exe");
        assert_eq!(
            procs[0].process_start_time.as_deref(),
            Some("tasklist:1234:chrome.exe")
        );
        assert_eq!(procs[1].pid, 56);
    }

    #[test]
    fn parses_ps_output() {
        let out = "  1234 chrome\n   56 sshd\ngarbage line\n 78  my app";
        let procs = parse_ps(out);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].name, "chrome");
        assert_eq!(procs[1].pid, 56);
        assert_eq!(procs[1].name, "sshd");
        // "my app" keeps the internal space.
        assert_eq!(procs[2].pid, 78);
        assert_eq!(procs[2].name, "my app");
    }

    #[test]
    fn parses_ps_with_lstart() {
        let out = "  1234 Wed Jul  1 12:00:00 2026 chrome";
        let procs = parse_ps(out);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].name, "chrome");
        assert_eq!(
            procs[0].process_start_time.as_deref(),
            Some("Wed Jul 1 12:00:00 2026")
        );
    }

    #[test]
    fn parses_powershell_process_csv() {
        let out = "\"Id\",\"ProcessName\",\"Path\",\"StartTime\"\n\
                   \"4242\",\"chrome\",\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\",\"7/1/2026 12:00:00 PM\"\n\
                   \"56\",\"svchost\",,\"\"";
        let procs = parse_powershell_process_csv(out);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 4242);
        assert_eq!(
            procs[0].path.as_deref(),
            Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        );
        assert_eq!(
            procs[0].process_start_time.as_deref(),
            Some("7/1/2026 12:00:00 PM")
        );
        assert_eq!(procs[1].pid, 56);
        assert!(procs[1].path.is_none());
    }

    #[test]
    fn protocol_and_reason_mapping() {
        assert_eq!(parse_protocol("udp"), Protocol::Udp);
        assert_eq!(parse_protocol("weird"), Protocol::Other);
        assert_eq!(reason_str(DecisionReason::SubscriptionProxy), "subscription-proxy");
    }
}
