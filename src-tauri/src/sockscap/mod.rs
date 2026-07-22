//! SocksCap — OS-level TCP traffic routing through HTTP / SOCKS5 / SSH.
//!
//! - Rules / policy / GFWList / egress dialers (all platforms)
//! - Windows capture: elevated `sockscap-helper` + WinDivert
//!   FLOW (PID) + NETWORK (IPv4 TCP NAT → local relay → policy → upstream)
//! - Linux / macOS capture: not yet (capabilities report unavailable)

mod capture;
mod config;
mod dns_win;
mod egress;
mod flow;
pub mod helper;
mod orchestrator;
mod paths;
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
pub use stats::DomainRecord;

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
    orch.apply_config(config.clone());
    // Hot-reload into running relay without restarting capture.
    let rules = orch.rules().map(|r| r.clone());
    orch.hot_reload_policy(config, rules).await;
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
            orch.apply_config(cfg.clone());
            orch.set_rules(compiled.clone());
            orch.hot_reload_policy(cfg, Some(compiled)).await;
            Ok(GfwListStatus {
                loaded: true,
                rule_count: meta.rule_count,
                skipped: meta.skipped,
                last_refresh: meta.last_refresh,
                source: meta.source,
                error: None,
            })
        }
        Err(e) => {
            // Keep previous rules if any; surface error for UI.
            let orch = state.sockscap.orch.read().await;
            if let Some(meta) = orch.gfwlist_meta() {
                Ok(GfwListStatus {
                    loaded: true,
                    rule_count: meta.rule_count,
                    skipped: meta.skipped,
                    last_refresh: meta.last_refresh.clone(),
                    source: meta.source.clone(),
                    error: Some(format!("refresh failed (kept cache): {e}")),
                })
            } else {
                Ok(GfwListStatus {
                    loaded: false,
                    rule_count: 0,
                    skipped: 0,
                    last_refresh: None,
                    source: fetch_url,
                    error: Some(e),
                })
            }
        }
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
    orch.set_rules(compiled.clone());
    if let Some(cfg) = orch.config().cloned() {
        orch.hot_reload_policy(cfg, Some(compiled)).await;
    }
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

    // GFWList mode: require rules (cache or fresh fetch) before capture.
    let mut gfw_start_note = String::new();
    if matches!(cfg.rule_mode, RuleMode::GfwList) {
        let mut orch = state.sockscap.orch.write().await;
        if orch.rules().is_none() {
            if let Some(c) = rules::source::load_cached(&dir) {
                gfw_start_note = format!(
                    "using cached GFWList ({} rules)",
                    c.meta.rule_count
                );
                orch.set_rules(c);
            } else if !cfg.gfwlist.url.trim().is_empty() {
                let url = cfg.gfwlist.url.clone();
                drop(orch);
                match rules::source::refresh_from_url(&url, &dir).await {
                    Ok(compiled) => {
                        gfw_start_note = format!(
                            "downloaded GFWList ({} rules)",
                            compiled.meta.rule_count
                        );
                        state.sockscap.orch.write().await.set_rules(compiled);
                    }
                    Err(e) => {
                        let mut orch = state.sockscap.orch.write().await;
                        orch.set_degraded(
                            "none",
                            format!("GFWList required but not loaded: {e}"),
                        );
                        return Err(format!(
                            "GFWList mode needs a ruleset. Refresh GFWList or import a file first. ({e})"
                        ));
                    }
                }
            } else {
                orch.set_degraded(
                    "none",
                    "GFWList URL empty and no cache".to_string(),
                );
                return Err(
                    "GFWList mode needs a ruleset. Set a URL and refresh, or import a local file."
                        .to_string(),
                );
            }
        } else if let Some(m) = orch.gfwlist_meta() {
            gfw_start_note = format!("GFWList ready ({} rules)", m.rule_count);
        }
    }
    if !gfw_start_note.is_empty() {
        tracing::info!("sockscap: {gfw_start_note}");
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
            let helper_port = state
                .sockscap
                .helper
                .inner
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|s| s.port));
            let relay_port = state
                .sockscap
                .orch
                .read()
                .await
                .relay
                .as_ref()
                .map(|r| r.port);
            recovery::write_journal(
                &journal_path,
                &recovery::RecoveryJournal {
                    platform: caps.platform.clone(),
                    capture_backend: st.capture_backend.clone(),
                    config_hash: cfg.content_hash(),
                    pid: std::process::id(),
                    clean: false,
                    relay_port,
                    helper_port,
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

    // 2) Resolve upstream credentials (manual fields; vault password_ref).
    let (mut up_host, mut up_port, mut up_user, mut up_pass) =
        relay::upstream_from_config(cfg);
    if !cfg.upstream.password_ref.is_empty() {
        if let Ok(Some(p)) = state.vault.resolve(&cfg.upstream.password_ref) {
            up_pass = (*p).clone();
        }
    }
    // Session-backed upstream: load host/port/user from sessions DB when set.
    if !cfg.upstream.session_id.is_empty() {
        if let Ok(db) = state.db.lock() {
            if let Ok(sess) = crate::session::db::get_session(&db, &cfg.upstream.session_id) {
                up_host = sess.host;
                up_port = sess.port;
                if let Some(u) = sess.username {
                    if !u.is_empty() {
                        up_user = u;
                    }
                }
            }
        }
    }

    // Optional SSH pool for capture-path PROXY via direct-tcpip.
    let ssh_pool = if matches!(cfg.upstream.kind, crate::sockscap::config::UpstreamKind::Ssh)
    {
        use crate::sockscap::egress::ssh_pool::SshPool;
        use crate::terminal::ssh::SshAuth;
        let auth = if !up_pass.is_empty() {
            SshAuth::Password(up_pass.clone())
        } else if !cfg.upstream.password_ref.is_empty()
            && cfg.upstream.password_ref.starts_with("key:")
        {
            // Convention unused; private key path stored in password_ref rare.
            SshAuth::PrivateKey(cfg.upstream.password_ref.clone())
        } else {
            // Prefer agent when no password.
            SshAuth::Agent
        };
        match SshPool::connect(&up_host, up_port, &up_user, auth).await {
            Ok(p) => Some(Arc::new(p)),
            Err(e) => {
                return Err(format!("SSH upstream connect failed: {e}"));
            }
        }
    } else {
        None
    };

    let (stats, domains) = {
        let orch = state.sockscap.orch.read().await;
        (Arc::clone(&orch.stats), Arc::clone(&orch.domains))
    };
    let rules = {
        let orch = state.sockscap.orch.read().await;
        orch.rules().map(|r| r.clone())
    };
    let dns_map = Arc::new(std::sync::Mutex::new(
        crate::sockscap::rules::dns_map::DnsMap::new(8192, std::time::Duration::from_secs(300)),
    ));
    // Seed from Windows DNS client cache (no admin).
    crate::sockscap::dns_win::refresh_dns_client_cache(&dns_map);

    let ctx = Arc::new(RwLock::new(RelayContext {
        config: cfg.clone(),
        rules,
        helper: Arc::clone(&state.sockscap.helper),
        stats,
        upstream_host: up_host.clone(),
        upstream_port: up_port,
        upstream_user: up_user,
        upstream_pass: up_pass,
        self_pid: std::process::id(),
        ssh_pool,
        dns_map: Arc::clone(&dns_map),
        domains,
    }));
    let relay_handle = relay::start_relay(Arc::clone(&ctx)).await?;

    // Periodic DNS cache refresh while capture runs (stopped via orch.dns_stop).
    let dns_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _dns_task = crate::sockscap::dns_win::spawn_dns_cache_refresher(
        dns_map,
        Arc::clone(&dns_stop),
        std::time::Duration::from_secs(60),
    );

    // 3) Tell helper to start FLOW+NETWORK capture → NAT to relay.
    let mut bypass_pids = vec![std::process::id()];
    if let Some(pid) = helper_st.pid {
        bypass_pids.push(pid);
    }
    let mut bypass_endpoints = Vec::new();
    if !up_host.is_empty() && up_port > 0 {
        bypass_endpoints.push((up_host, up_port));
    }
    // Relay listens on 0.0.0.0 / :: (streamdump reflection). Bypass those endpoints
    // so we never re-capture the proxy's own accept path as a new flow.
    bypass_endpoints.push(("127.0.0.1".into(), relay_handle.port));
    bypass_endpoints.push(("::1".into(), relay_handle.port));
    bypass_endpoints.push(("0.0.0.0".into(), relay_handle.port));

    let args = CaptureStartArgs {
        mode_apps: matches!(cfg.mode, ScopeMode::Apps),
        app_paths: cfg
            .apps
            .iter()
            .map(|a| paths::normalize_exe_path(&a.path))
            .filter(|p| !p.is_empty())
            .collect(),
        bypass_cidrs: cfg.bypass_cidrs.clone(),
        bypass_pids,
        bypass_endpoints,
        // Unused for streamdump reflection dest (kept for helper JSON compat).
        relay_ip: "0.0.0.0".into(),
        relay_port: relay_handle.port,
    };

    if args.mode_apps && args.app_paths.is_empty() {
        dns_stop.store(true, std::sync::atomic::Ordering::SeqCst);
        relay_handle.stop().await;
        return Err("App mode requires at least one application path".into());
    }

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
            orch.relay_ctx = Some(ctx);
            orch.dns_stop = Some(dns_stop);
            let gfw_note = orch
                .gfwlist_meta()
                .map(|m| format!(", gfw={}", m.rule_count))
                .unwrap_or_default();
            orch.set_active(
                &caps.capture_backend,
                format!(
                    "capture active (relay :{}, elevated=true{gfw_note})",
                    args.relay_port
                ),
            );
            tracing::info!("sockscap capture started: {info}");
            Ok(orch.status())
        }
        Err(e) => {
            dns_stop.store(true, std::sync::atomic::Ordering::SeqCst);
            relay_handle.stop().await;
            let mut orch = state.sockscap.orch.write().await;
            orch.set_degraded(
                &caps.capture_backend,
                format!("helper/capture failed: {e}"),
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
    full_teardown(&app, &state).await;
    let orch = state.sockscap.orch.read().await;
    Ok(orch.status())
}

#[tauri::command]
pub async fn sockscap_recover(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    full_teardown(&app, &state).await;
    capture::recover_system().await?;
    Ok(())
}

/// Thorough capture teardown:
/// 1) Stop WinDivert NETWORK capture in the elevated helper (with timeout)
/// 2) Stop local relay accept loops (IPv4+IPv6 wake + abort fallback)
/// 3) Stop DNS refresher, clear relay ctx, mark recovery journal clean
///
/// Does **not** kill the elevated helper process (avoids another UAC on next Start).
async fn full_teardown(app: &AppHandle, state: &State<'_, AppState>) {
    use std::time::Duration;

    // --- 1) Helper capture_stop (blocking RPC) off the async runtime ----------
    let sess = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());
    if let Some(sess) = sess {
        let stop_rpc = tokio::task::spawn_blocking(move || helper::capture_stop(&sess));
        match tokio::time::timeout(Duration::from_secs(4), stop_rpc).await {
            Ok(Ok(Ok(()))) => {
                tracing::info!("sockscap: helper capture_stop ok");
            }
            Ok(Ok(Err(e))) => {
                tracing::warn!("sockscap: helper capture_stop error: {e}");
            }
            Ok(Err(e)) => {
                tracing::warn!("sockscap: helper capture_stop join error: {e}");
            }
            Err(_) => {
                tracing::warn!(
                    "sockscap: helper capture_stop timed out after 4s (WinDivert threads may still be exiting)"
                );
            }
        }
    }

    // --- 2) Take relay without holding write lock during await ---------------
    let relay = {
        let mut orch = state.sockscap.orch.write().await;
        orch.take_relay_for_stop()
    };
    if let Some(relay) = relay {
        // Internal: dual-stack wake + 800ms abort fallback.
        relay.stop().await;
    }

    // --- 3) Finish engine state + DNS + journal ------------------------------
    {
        let mut orch = state.sockscap.orch.write().await;
        orch.finish_stop();
    }
    if let Ok(dir) = data_dir(app) {
        let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
    }
    tracing::info!("sockscap: teardown complete");
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
    let target_host = test_host.unwrap_or_else(|| "www.google.com".into());
    let target_port = test_port.unwrap_or(443);
    let user = username.unwrap_or_default();
    let mut pass = password.unwrap_or_default();
    // Resolve vault:<id> if the UI passed a password_ref.
    if pass.starts_with("vault:") {
        if let Ok(Some(p)) = state.vault.resolve(&pass) {
            pass = (*p).clone();
        }
    }

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
        "ssh" => {
            use crate::sockscap::egress::ssh_pool::SshPool;
            use crate::terminal::ssh::SshAuth;
            let auth = if pass.is_empty() {
                SshAuth::Agent
            } else {
                SshAuth::Password(pass)
            };
            let pool = SshPool::connect(&host, port, &user, auth).await?;
            let stream = pool
                .dial(&target_host, target_port, "127.0.0.1", 0)
                .await?;
            // Drop after successful open.
            drop(stream);
            Ok(format!(
                "SSH direct-tcpip via {host}:{port} to {target_host}:{target_port} ok"
            ))
        }
        other => Err(format!("unknown upstream kind: {other}")),
    }
}

/// Boot-time hook: if the previous run left a dirty recovery journal, force
/// platform recover so the OS is not left with half-installed capture rules.
pub async fn boot_repair(app: &AppHandle) {
    let Ok(dir) = data_dir(app) else {
        return;
    };
    let journal_path = recovery::journal_path(&dir);
    if !recovery::needs_repair(&journal_path) {
        return;
    }
    tracing::warn!("sockscap: dirty recovery journal — repairing network state");
    if let Some(j) = recovery::read_journal(&journal_path) {
        tracing::warn!(
            "sockscap: dirty journal pid={} backend={} relay={:?} helper={:?}",
            j.pid,
            j.capture_backend,
            j.relay_port,
            j.helper_port
        );
    }
    // Previous helper cannot be contacted without its token; platform recover
    // + clear journal so the next Start opens a fresh elevated helper.
    if let Err(e) = capture::recover_system().await {
        tracing::warn!("sockscap: boot recover failed: {e}");
    }
    let _ = recovery::mark_clean_and_clear(&journal_path);
    tracing::info!("sockscap: recovery complete");
}

#[tauri::command]
pub async fn sockscap_get_domain_records(
    state: State<'_, AppState>,
) -> Result<Vec<DomainRecord>, String> {
    let orch = state.sockscap.orch.read().await;
    let guard = orch.domains.lock().map_err(|e| e.to_string())?;
    Ok(guard.snapshot())
}

#[tauri::command]
pub async fn sockscap_clear_domain_records(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let orch = state.sockscap.orch.read().await;
    let mut guard = orch.domains.lock().map_err(|e| e.to_string())?;
    guard.clear();
    Ok(())
}
