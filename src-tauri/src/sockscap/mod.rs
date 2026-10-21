//! SocksCap — OS-level TCP traffic routing through HTTP / SOCKS5 / SSH.
//!
//! - Rules / policy / GFWList / egress dialers (all platforms)
//! - Windows capture: elevated `sockscap-helper` + WinDivert
//!   FLOW (PID) + NETWORK (IPv4 TCP NAT → local relay → policy → upstream)
//! - Linux capture: nftables OUTPUT redirect + cgroup v2 + loopback relay
//! - macOS capture: signed Mitmproxy Redirector → Unix IPC → shared relay
//!   (transparent Global; application identity gate follows on the same engine)

mod lifecycle;
pub use lifecycle::*;
mod configuration_commands;
pub use configuration_commands::*;
mod upstream;
pub use upstream::*;
mod linux_capture;
use linux_capture::*;
mod launch;
pub use launch::*;
mod macos_capture;
use macos_capture::*;
mod windows_capture;
use windows_capture::*;
mod recovery_service;
pub use recovery_service::*;
mod diagnostics;
pub use diagnostics::*;
#[cfg(test)]
mod tests;

pub mod capture;
pub mod config;
pub mod core;
pub mod dns_win;
pub mod egress;
#[cfg(unix)]
pub mod elevate;
pub mod flow;
pub mod helper;
pub mod ingress;
pub mod listener_pid;
pub mod orchestrator;
pub mod paths;
pub mod policy;
pub mod process;
pub mod recovery;
pub mod redirector;
pub mod relay;
pub mod rules;
pub mod stats;
pub mod tun_detect;

pub use config::{Decision, RuleMode, SocksCapConfig};
pub use orchestrator::{Orchestrator, SocksCapStatus};
pub use policy::{PolicyEngine, PolicyInput};
pub use rules::GfwListMeta;
pub use stats::DomainRecord;

use std::path::PathBuf;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::RwLock;
use zeroize::Zeroizing;

use crate::module_lock::ModuleLock;
use crate::state::AppState;

/* ---------------------------- runtime handle ---------------------------- */

/// Shared SocksCap runtime living on [`AppState`].
pub struct SocksCapRuntime {
    pub orch: Arc<RwLock<Orchestrator>>,
    pub helper: Arc<helper::HelperRegistry>,
    /// Orphaned elevated helper pids that this (unelevated) process could not
    /// terminate. Handed to the next helper launch, which runs under UAC and
    /// can finish the job. See [`boot_repair`].
    pub pending_reap: std::sync::Mutex<Vec<u32>>,
    /// Cross-process ownership of the OS capture stack. SocksCap changes
    /// machine-wide capture state, so only one Taomni process may own it.
    activation_lock: std::sync::Mutex<Option<ModuleLock>>,
    /// macOS starts boot recovery asynchronously. Start remains blocked until
    /// that audit has finished so a user click cannot race a dirty-journal
    /// recovery and replace its inert-only scope with a business scope.
    #[cfg(target_os = "macos")]
    recovery_ready: AtomicBool,
    /// xray-core sidecar pool for core-backed upstreams. Initialized during
    /// `setup()` once the `AppHandle` (resource dir / app data dir) is available
    /// via [`init_xray_manager`]; `None` until then.
    pub xray: std::sync::OnceLock<Arc<core::XrayManager>>,
}

impl SocksCapRuntime {
    pub fn new() -> Self {
        Self {
            orch: Arc::new(RwLock::new(Orchestrator::new())),
            helper: Arc::new(helper::HelperRegistry::new()),
            pending_reap: std::sync::Mutex::new(Vec::new()),
            activation_lock: std::sync::Mutex::new(None),
            #[cfg(target_os = "macos")]
            recovery_ready: AtomicBool::new(false),
            xray: std::sync::OnceLock::new(),
        }
    }

    /// The xray manager, if it has been initialized.
    pub fn xray(&self) -> Option<&Arc<core::XrayManager>> {
        self.xray.get()
    }

    fn has_activation_lock(&self) -> bool {
        self.activation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    fn install_activation_lock(&self, lock: ModuleLock) {
        *self
            .activation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(lock);
    }

    fn release_activation_lock(&self) {
        self.activation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }

    #[cfg(target_os = "macos")]
    fn recovery_ready(&self) -> bool {
        self.recovery_ready.load(Ordering::Acquire)
    }

    #[cfg(target_os = "macos")]
    fn mark_recovery_ready(&self) {
        self.recovery_ready.store(true, Ordering::Release);
    }
}

#[cfg(target_os = "macos")]
struct RecoveryReadyGuard<'a>(&'a SocksCapRuntime);

#[cfg(target_os = "macos")]
impl Drop for RecoveryReadyGuard<'_> {
    fn drop(&mut self) {
        self.0.mark_recovery_ready();
    }
}

impl Default for SocksCapRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::resolved_app_data_dir(app)?.join("sockscap");
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linux: Option<LinuxCaptureCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxCaptureCapabilities {
    pub transparent_available: bool,
    pub launched_application_available: bool,
    pub launch_only: bool,
    pub containerized: bool,
    pub transparent_unavailable_reason: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetTestResult {
    pub host: String,
    pub port: u16,
    pub decision: Decision,
    pub reason: String,
    pub matched_rule: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksCapDiagnostics {
    pub generated_at: u64,
    pub status: SocksCapStatus,
    pub capabilities: SocksCapCapabilities,
    pub stats: stats::StatsSnapshot,
    pub recovery_journal: Option<recovery::RecoveryJournal>,
    pub redirector: Option<serde_json::Value>,
    pub manual_recovery_steps: Vec<String>,
}

/// Synthetic manager key for the global (non-profile) upstream's core.
const GLOBAL_CORE_KEY: &str = "__global__";

/// A local proxy discovered on the machine, offered as a one-click upstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProxyCandidate {
    /// "socks5" | "http" — detected by a lightweight handshake probe.
    pub kind: String,
    pub host: String,
    pub port: u16,
    /// Listening process name (best-effort; empty if not resolvable).
    pub process: String,
    /// Owning pid of the listener (0 if unknown).
    pub pid: u32,
    /// Normalized client family id derived from the process name
    /// ("clash" | "mihomo" | "sing-box" | "v2rayn" | "xray" | … | "unknown").
    /// Lets the UI group candidates by client.
    pub client: String,
    /// Human-friendly client name for display ("Clash Verge", "sing-box", …).
    /// Empty for the "unknown" family.
    pub client_label: String,
}

/// Common local-proxy listen ports for popular clients (Clash/Mihomo mixed,
/// v2rayN/xray, generic SOCKS/HTTP). Probed on 127.0.0.1 only.
const COMMON_PROXY_PORTS: &[u16] = &[
    7890, 7891, 7892, 7897, // Clash / Mihomo (mixed / socks / http / verge)
    10808, 10809, // v2rayN (socks / http)
    2080, 2081, // sing-box / others
    1080, 1081, // generic SOCKS
    8889, 8080, // generic HTTP
    20170, 20171, // Qv2ray defaults
];

/// A helper-ready file left in the sockscap data dir by some previous launch.
#[derive(Debug)]
struct StaleReadyFile {
    path: PathBuf,
    pid: Option<u32>,
    parent_pid: Option<u32>,
}
