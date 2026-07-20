//! SocksCap — OS-level TCP traffic routing through HTTP / SOCKS5 / SSH.
//!
//! - Rules / policy / GFWList / egress dialers (all platforms)
//! - Windows capture: elevated `sockscap-helper` + WinDivert
//!   FLOW (PID) + NETWORK (IPv4 TCP NAT → local relay → policy → upstream)
//! - Linux / macOS capture: not yet (capabilities report unavailable)

mod capture;
mod config;
mod egress;
mod flow;
pub mod helper;
mod orchestrator;
mod policy;
mod process;
mod recovery;
pub mod relay;
mod rules;
mod stats;

pub use config::{Decision, RuleMode, SocksCapConfig};
pub use orchestrator::{Orchestrator, SocksCapStatus};
pub use policy::{PolicyEngine, PolicyInput};
pub use rules::GfwListMeta;

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

use crate::state::AppState;

/* ---------------------------- runtime handle ---------------------------- */

/// Shared SocksCap runtime living on [`AppState`].
pub struct SocksCapRuntime {
    pub orch: Arc<RwLock<Orchestrator>>,
    pub helper: Arc<helper::HelperRegistry>,
}

impl SocksCapRuntime {
    pub fn new() -> Self {
        Self {
            orch: Arc::new(RwLock::new(Orchestrator::new())),
            helper: Arc::new(helper::HelperRegistry::new()),
        }
    }
}

impl Default for SocksCapRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("sockscap");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create sockscap dir: {e}"))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("config.json"))
}

fn rules_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("rules");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create rules dir: {e}"))?;
    Ok(dir)
}

/* ---------------------------- capabilities ------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksCapCapabilities {
    pub platform: String,
    pub global_tcp: bool,
    pub app_filter: bool,
    pub capture_backend: String,
    pub notes: Vec<String>,
    pub privileged_required: bool,
}

#[tauri::command]
pub async fn sockscap_capabilities() -> Result<SocksCapCapabilities, String> {
    Ok(capture::capabilities())
}

/* ---------------------------- config ------------------------------------ */

#[tauri::command]
pub async fn sockscap_get_config(app: AppHandle) -> Result<SocksCapConfig, String> {
    let path = config_path(&app)?;
    Ok(SocksCapConfig::load(&path))
}

#[tauri::command]
pub async fn sockscap_set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SocksCapConfig,
) -> Result<(), String> {
    config.validate()?;
    let path = config_path(&app)?;
    config.save(&path)?;
    let mut orch = state.sockscap.orch.write().await;
    orch.apply_config(config);
    Ok(())
}

/* ---------------------------- rules ------------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfwListStatus {
    pub loaded: bool,
    pub rule_count: usize,
    pub skipped: usize,
    pub last_refresh: Option<String>,
    pub source: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn sockscap_gfwlist_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GfwListStatus, String> {
    let orch = state.sockscap.orch.read().await;
    if let Some(meta) = orch.gfwlist_meta() {
        return Ok(GfwListStatus {
            loaded: true,
            rule_count: meta.rule_count,
            skipped: meta.skipped,
            last_refresh: meta.last_refresh.clone(),
            source: meta.source.clone(),
            error: None,
        });
    }
    // Fall back to disk meta if engine has not loaded yet.
    let meta_path = rules_dir(&app)?.join("gfwlist.meta.json");
    match GfwListMeta::load(&meta_path) {
        Some(m) => Ok(GfwListStatus {
            loaded: true,
            rule_count: m.rule_count,
            skipped: m.skipped,
            last_refresh: m.last_refresh,
            source: m.source,
            error: None,
        }),
        None => Ok(GfwListStatus {
            loaded: false,
            rule_count: 0,
            skipped: 0,
            last_refresh: None,
            source: String::new(),
            error: None,
        }),
    }
}

#[tauri::command]
pub async fn sockscap_refresh_gfwlist(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
) -> Result<GfwListStatus, String> {
    let cfg_path = config_path(&app)?;
    let mut cfg = SocksCapConfig::load(&cfg_path);
    let fetch_url = url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| cfg.gfwlist.url.clone());
    if !fetch_url.trim().is_empty() {
        cfg.gfwlist.url = fetch_url.clone();
    }

    let dir = rules_dir(&app)?;
    let result = rules::source::refresh_from_url(&fetch_url, &dir).await;
    match result {
        Ok(compiled) => {
            let meta = compiled.meta.clone();
            cfg.save(&cfg_path)?;
            let mut orch = state.sockscap.orch.write().await;
            orch.apply_config(cfg);
            orch.set_rules(compiled);
            Ok(GfwListStatus {
                loaded: true,
                rule_count: meta.rule_count,
                skipped: meta.skipped,
                last_refresh: meta.last_refresh,
                source: meta.source,
                error: None,
            })
        }
        Err(e) => Ok(GfwListStatus {
            loaded: false,
            rule_count: 0,
            skipped: 0,
            last_refresh: None,
            source: fetch_url,
            error: Some(e),
        }),
    }
}

#[tauri::command]
pub async fn sockscap_import_rules(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<GfwListStatus, String> {
    let dir = rules_dir(&app)?;
    let compiled = rules::source::import_from_path(std::path::Path::new(&path), &dir)?;
    let meta = compiled.meta.clone();
    let mut orch = state.sockscap.orch.write().await;
    orch.set_rules(compiled);
    Ok(GfwListStatus {
        loaded: true,
        rule_count: meta.rule_count,
        skipped: meta.skipped,
        last_refresh: meta.last_refresh,
        source: meta.source,
        error: None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetTestResult {
    pub host: String,
    pub port: u16,
    pub decision: Decision,
    pub reason: String,
    pub matched_rule: Option<String>,
}

#[tauri::command]
pub async fn sockscap_test_target(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    port: Option<u16>,
) -> Result<TargetTestResult, String> {
    let port = port.unwrap_or(443);
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("host is empty".into());
    }

    // Ensure rules are loaded into the orchestrator for dry-run.
    {
        let mut orch = state.sockscap.orch.write().await;
        if orch.rules().is_none() {
            let dir = rules_dir(&app)?;
            if let Some(c) = rules::source::load_cached(&dir) {
                orch.set_rules(c);
            }
        }
        if orch.config().is_none() {
            let cfg = SocksCapConfig::load(&config_path(&app)?);
            orch.apply_config(cfg);
        }
    }

    let orch = state.sockscap.orch.read().await;
    let cfg = orch
        .config()
        .cloned()
        .unwrap_or_else(SocksCapConfig::default);
    let engine = PolicyEngine::from_config(&cfg, orch.rules());
    let input = PolicyInput {
        host: Some(host.clone()),
        ip: host.parse().ok(),
        port,
        process_path: None,
        pid: None,
    };
    let trace = engine.decide(&input);
    Ok(TargetTestResult {
        host,
        port,
        decision: trace.decision,
        reason: trace.reason,
        matched_rule: trace.matched_rule,
    })
}

/* ---------------------------- lifecycle --------------------------------- */

#[tauri::command]
pub async fn sockscap_status(state: State<'_, AppState>) -> Result<SocksCapStatus, String> {
    let orch = state.sockscap.orch.read().await;
    Ok(orch.status())
}

#[tauri::command]
pub async fn sockscap_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SocksCapStatus, String> {
    let cfg_path = config_path(&app)?;
    let cfg = SocksCapConfig::load(&cfg_path);
    cfg.validate()?;

    let dir = rules_dir(&app)?;
    {
        let mut orch = state.sockscap.orch.write().await;
        if orch.is_running() {
            return Err("sockscap already running".into());
        }
        orch.apply_config(cfg.clone());
        orch.set_preparing("starting");
    }

    // Load cached GFWList when needed; optionally fetch if cache missing.
    {
        let mut orch = state.sockscap.orch.write().await;
        if matches!(cfg.rule_mode, RuleMode::GfwList) && orch.rules().is_none() {
            if let Some(c) = rules::source::load_cached(&dir) {
                orch.set_rules(c);
            } else if !cfg.gfwlist.url.trim().is_empty() {
                let url = cfg.gfwlist.url.clone();
                drop(orch);
                match rules::source::refresh_from_url(&url, &dir).await {
                    Ok(compiled) => {
                        state.sockscap.orch.write().await.set_rules(compiled);
                    }
                    Err(e) => {
                        tracing::warn!("sockscap: gfwlist fetch on start failed: {e}");
                    }
                }
            }
        }
    }

    let caps = capture::capabilities();
    let journal_path = data_dir(&app)?.join("recovery.json");

    #[cfg(windows)]
    let status = start_windows_capture(&app, &state, &cfg, &caps).await;

    #[cfg(not(windows))]
    let status = {
        let mut orch = state.sockscap.orch.write().await;
        orch.apply_config(cfg.clone());
        let _ = orch.start_stub(&caps);
        Ok(orch.status())
    };

    match &status {
        Ok(st) => {
            recovery::write_journal(
                &journal_path,
                &recovery::RecoveryJournal {
                    platform: caps.platform.clone(),
                    capture_backend: st.capture_backend.clone(),
                    config_hash: cfg.content_hash(),
                    pid: std::process::id(),
                    clean: false,
                },
            )?;
        }
        Err(e) => {
            let mut orch = state.sockscap.orch.write().await;
            orch.set_degraded(&caps.capture_backend, e.clone());
        }
    }

    status
}

#[cfg(windows)]
async fn start_windows_capture(
    app: &AppHandle,
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
    caps: &capture::SocksCapCapabilities,
) -> Result<SocksCapStatus, String> {
    use crate::sockscap::config::ScopeMode;
    use crate::sockscap::helper::{CaptureStartArgs, capture_start, ensure_helper};
    use crate::sockscap::relay::{self, RelayContext};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    // 1) Elevated helper (UAC).
    let helper_st = ensure_helper(app, state).await?;
    if !helper_st.running {
        return Err(helper_st.message);
    }

    // 2) Local relay for NAT'd TCP.
    let (up_host, up_port, up_user, up_pass) = relay::upstream_from_config(cfg);
    let stats = {
        let orch = state.sockscap.orch.read().await;
        Arc::clone(&orch.stats)
    };
    let rules = {
        let orch = state.sockscap.orch.read().await;
        orch.rules().map(|r| r.clone())
    };
    let ctx = Arc::new(RwLock::new(RelayContext {
        config: cfg.clone(),
        rules,
        helper: Arc::clone(&state.sockscap.helper),
        stats,
        upstream_host: up_host,
        upstream_port: up_port,
        upstream_user: up_user,
        upstream_pass: up_pass,
        self_pid: std::process::id(),
    }));
    let relay_handle = relay::start_relay(Arc::clone(&ctx)).await?;

    // 3) Tell helper to start FLOW+NETWORK capture → NAT to relay.
    let mut bypass_pids = vec![std::process::id()];
    if let Some(pid) = helper_st.pid {
        bypass_pids.push(pid);
    }
    let mut bypass_endpoints = Vec::new();
    if !cfg.upstream.host.is_empty() && cfg.upstream.port > 0 {
        bypass_endpoints.push((cfg.upstream.host.clone(), cfg.upstream.port));
    }
    // Always bypass loopback relay itself.
    bypass_endpoints.push(("127.0.0.1".into(), relay_handle.port));

    let args = CaptureStartArgs {
        mode_apps: matches!(cfg.mode, ScopeMode::Apps),
        app_paths: cfg.apps.iter().map(|a| a.path.clone()).collect(),
        bypass_cidrs: cfg.bypass_cidrs.clone(),
        bypass_pids,
        bypass_endpoints,
        relay_ip: "127.0.0.1".into(),
        relay_port: relay_handle.port,
    };

    let capture_result = {
        let guard = state
            .sockscap
            .helper
            .inner
            .lock()
            .map_err(|e| e.to_string())?;
        let sess = guard
            .as_ref()
            .ok_or_else(|| "helper session lost".to_string())?;
        capture_start(sess, &args)
    };

    match capture_result {
        Ok(info) => {
            let mut orch = state.sockscap.orch.write().await;
            orch.relay = Some(relay_handle);
            orch.set_active(
                &caps.capture_backend,
                format!(
                    "capture active (relay :{}, helper elevated={})",
                    args.relay_port, helper_st.elevated
                ),
            );
            tracing::info!("sockscap capture started: {info}");
            Ok(orch.status())
        }
        Err(e) => {
            relay_handle.stop().await;
            let mut orch = state.sockscap.orch.write().await;
            orch.set_degraded(
                &caps.capture_backend,
                format!("helper/capture failed: {e} (is WinDivert.dll installed?)"),
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn sockscap_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SocksCapStatus, String> {
    // Stop helper capture first (if any).
    {
        let guard = state.sockscap.helper.inner.lock().ok();
        if let Some(guard) = guard {
            if let Some(sess) = guard.as_ref() {
                let _ = helper::capture_stop(sess);
            }
        }
    }

    let mut orch = state.sockscap.orch.write().await;
    orch.stop().await?;
    let journal_path = data_dir(&app)?.join("recovery.json");
    let _ = recovery::clear_journal(&journal_path);
    Ok(orch.status())
}

#[tauri::command]
pub async fn sockscap_recover(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let journal_path = data_dir(&app)?.join("recovery.json");
    // Platform-specific recovery will live in capture::*; for now clear journal
    // and reset orchestrator to Idle.
    // Best-effort: stop capture + relay.
    {
        let guard = state.sockscap.helper.inner.lock().ok();
        if let Some(guard) = guard {
            if let Some(sess) = guard.as_ref() {
                let _ = helper::capture_stop(sess);
            }
        }
    }
    {
        let mut orch = state.sockscap.orch.write().await;
        let _ = orch.stop().await;
        orch.force_idle();
    }
    let _ = recovery::clear_journal(&journal_path);
    capture::recover_system().await?;
    Ok(())
}

#[tauri::command]
pub async fn sockscap_stats_snapshot(
    state: State<'_, AppState>,
) -> Result<stats::StatsSnapshot, String> {
    let orch = state.sockscap.orch.read().await;
    Ok(orch.stats_snapshot())
}

#[tauri::command]
pub async fn sockscap_list_processes() -> Result<Vec<process::ProcessInfo>, String> {
    process::list_processes()
}

#[tauri::command]
pub async fn sockscap_test_upstream(
    state: State<'_, AppState>,
    kind: String,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    test_host: Option<String>,
    test_port: Option<u16>,
) -> Result<String, String> {
    let _ = state; // vault/session resolution lands with full upstream wiring
    let target_host = test_host.unwrap_or_else(|| "www.google.com".into());
    let target_port = test_port.unwrap_or(443);
    let user = username.unwrap_or_default();
    let pass = password.unwrap_or_default();

    match kind.as_str() {
        "http" => {
            egress::http_connect::dial(&host, port, &target_host, target_port, &user, &pass).await?;
            Ok(format!(
                "HTTP CONNECT via {}:{} to {}:{} ok",
                host, port, target_host, target_port
            ))
        }
        "socks5" => {
            egress::socks5::dial(&host, port, &target_host, target_port, &user, &pass).await?;
            Ok(format!(
                "SOCKS5 via {}:{} to {}:{} ok",
                host, port, target_host, target_port
            ))
        }
        "ssh" => Err(
            "SSH upstream test requires a saved session id; full pool lands with capture wiring"
                .into(),
        ),
        other => Err(format!("unknown upstream kind: {other}")),
    }
}

/// Boot-time hook: if the previous run left a dirty recovery journal, force
/// platform recover so the OS is not left with half-installed capture rules.
pub async fn boot_repair(app: &AppHandle) {
    let Ok(dir) = data_dir(app) else {
        return;
    };
    let journal_path = dir.join("recovery.json");
    if recovery::needs_repair(&journal_path) {
        tracing::warn!("sockscap: dirty recovery journal — attempting system recover");
        if let Err(e) = capture::recover_system().await {
            tracing::warn!("sockscap: boot recover failed: {e}");
        }
        let _ = recovery::clear_journal(&journal_path);
    }
}
