//! Own the processes and loopback listeners for SocksCap upstreams.

mod executable;

pub use taomni_sockscap_api::{share_link, xray_config as config_gen};

use executable::XrayExecutable;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

use sha2::{Digest, Sha256};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub use config_gen::ResolvedCoreUpstream;

/// How long to wait for the spawned core's SOCKS inbound to accept connections.
const CORE_READY_TIMEOUT: Duration = Duration::from_secs(8);
const CORE_READY_POLL: Duration = Duration::from_millis(100);

/// A single running xray-core process serving one upstream's local SOCKS port.
pub struct XrayCore {
    child: Child,
    /// Loopback SOCKS port the relay dials.
    pub local_port: u16,
    /// Hash of the outbound spec — lets the manager reuse an unchanged core.
    pub config_hash: String,
    _scratch: tempfile::TempDir,
    /// xray stderr log, removed on shutdown/Drop. Its tail is surfaced in the
    /// error when a core fails to start (bad cipher/uuid/reality key/etc).
    log_file: PathBuf,
}

impl std::fmt::Debug for XrayCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("XrayCore")
            .field("local_port", &self.local_port)
            .field("config_hash", &self.config_hash)
            .field("pid", &self.child.id())
            .finish()
    }
}

impl XrayCore {
    /// Spawn xray for `spec`, send the config through stdin and return
    /// once the loopback SOCKS inbound is accepting connections.
    async fn spawn(
        exe: &XrayExecutable,
        work_dir: &Path,
        spec: &ResolvedCoreUpstream,
        config_hash: String,
        preferred_port: Option<u16>,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(work_dir).map_err(|e| format!("create xray work dir: {e}"))?;

        // A respawn (health-check restart) reuses the dead core's port so the
        // relay's cached xray_port stays valid; first spawn picks a free one.
        let local_port = preferred_port
            .map(Ok)
            .unwrap_or_else(pick_free_loopback_port)?;
        let config = spec.to_xray_config(local_port)?;
        let json = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("serialize xray config: {e}"))?;

        let executable = exe.prepare(work_dir)?;
        let scratch = tempfile::Builder::new()
            .prefix("xray-logs-")
            .tempdir_in(work_dir)
            .map_err(|e| format!("create private xray log directory: {e}"))?;

        // Capture output so a failed/misbehaving core is diagnosable instead of
        // a black box. xray writes config errors to stdout and runtime/handshake
        // errors to stderr, so route BOTH to the log (a null stdout is how a bad
        // cipher/uuid used to vanish silently).
        let log_file = scratch.path().join("output.log");
        let log_out =
            std::fs::File::create(&log_file).map_err(|e| format!("create xray log: {e}"))?;
        let log_err = log_out
            .try_clone()
            .map_err(|e| format!("clone xray log handle: {e}"))?;

        let mut cmd = Command::new(executable);
        cmd.arg("run")
            .arg("-c")
            .arg("stdin:")
            .env_remove("TAOMNI_PLUGIN_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log_out))
            .stderr(Stdio::from(log_err))
            // Also reaps a partially initialized child if the request is cancelled.
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| format!("spawn xray: {e}"))?;
        let mut input = child.stdin.take().ok_or("xray stdin is unavailable")?;

        let mut core = Self {
            child,
            local_port,
            config_hash,
            _scratch: scratch,
            log_file,
        };

        let ready = async {
            input
                .write_all(json.as_bytes())
                .await
                .map_err(|e| format!("send xray config: {e}"))?;
            drop(input);
            core.wait_until_ready().await
        };
        if let Err(e) = ready.await {
            // Reap the process first so its stdout/stderr are flushed and the
            // log file is complete, THEN read the tail, THEN clean up. (Reading
            // before the child is reaped can catch an empty/partial log.)
            let _ = core.child.start_kill();
            let _ = core.child.wait().await;
            let detail = core.log_tail(1024);
            return Err(if detail.is_empty() {
                e
            } else {
                format!("{e}\nxray log:\n{detail}")
            });
        }
        Ok(core)
    }

    /// Last `max` bytes of the xray stderr log, trimmed. Empty if unreadable.
    fn log_tail(&self, max: usize) -> String {
        let Ok(bytes) = std::fs::read(&self.log_file) else {
            return String::new();
        };
        let start = bytes.len().saturating_sub(max);
        String::from_utf8_lossy(&bytes[start..]).trim().to_string()
    }

    async fn wait_until_ready(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + CORE_READY_TIMEOUT;
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], self.local_port));
        loop {
            // Fail fast if the process already exited (bad config, missing lib).
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "xray exited early ({status}); check config/protocol params"
                    ));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("xray wait: {e}")),
            }
            if tokio::time::timeout(
                Duration::from_millis(300),
                tokio::net::TcpStream::connect(addr),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .is_some()
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "xray SOCKS inbound 127.0.0.1:{} not ready after {}s",
                    self.local_port,
                    CORE_READY_TIMEOUT.as_secs()
                ));
            }
            tokio::time::sleep(CORE_READY_POLL).await;
        }
    }

    /// Kill the process (awaits reaping) and remove the temp config + log.
    pub async fn shutdown(&mut self) {
        if let Err(e) = self.child.start_kill() {
            tracing::warn!("xray core kill (port {}): {e}", self.local_port);
        }
        let _ = self.child.wait().await;
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// True while the process is still running. `try_wait` is non-blocking; a
    /// reaped/exited child (crash, OOM, external kill) returns false.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// Stable hash of the outbound-relevant parts of a spec, so the manager can
/// tell whether a profile's core needs restarting on config change. Excludes
/// the local port (assigned per spawn).
pub fn spec_config_hash(spec: &ResolvedCoreUpstream) -> String {
    let mut h = Sha256::new();
    h.update(spec.kind.as_tag().as_bytes());
    h.update([0]);
    h.update(spec.host.as_bytes());
    h.update(spec.port.to_be_bytes());
    h.update(spec.secret.as_bytes());
    h.update(spec.uuid.as_bytes());
    h.update(spec.private_key.as_bytes());
    h.update(spec.pre_shared_key.as_bytes());
    // params: serialize deterministically.
    if let Ok(pj) = serde_json::to_vec(&spec.params) {
        h.update(&pj);
    }
    hex::encode(&h.finalize()[..12])
}

/// Manages one xray-core process per active core-backed profile.
///
/// Keyed by profile id so multiple profiles with different nodes run
/// side-by-side, exactly like the per-profile `ssh_pool` entries.
/// A running core plus the spec it was spawned from, so a crashed core can be
/// respawned (on the same local port) without the relay re-resolving anything.
struct ManagedCore {
    core: XrayCore,
    spec: ResolvedCoreUpstream,
}

pub struct XrayManager {
    inner: Mutex<HashMap<String, ManagedCore>>,
    exe: XrayExecutable,
    work_dir: PathBuf,
    /// Health-check monitor task handle (started at capture start, aborted on
    /// teardown). Behind a std Mutex so the sync exit-hook can stop it too.
    monitor: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl XrayManager {
    pub fn new(exe: Option<PathBuf>, work_dir: PathBuf) -> Self {
        Self::with_executable(XrayExecutable::Fixture(exe), work_dir)
    }

    pub fn packaged(exe: PathBuf, work_dir: PathBuf) -> Self {
        Self::with_executable(XrayExecutable::Packaged(exe), work_dir)
    }

    fn with_executable(exe: XrayExecutable, work_dir: PathBuf) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            exe,
            work_dir,
            monitor: std::sync::Mutex::new(None),
        }
    }

    pub fn has_exe(&self) -> bool {
        !matches!(self.exe, XrayExecutable::Fixture(None))
    }

    /// Ensure a core is running for `profile_id` matching `spec`, returning its
    /// local SOCKS port. Reuses an existing core when the spec is unchanged;
    /// otherwise (re)spawns. Non-core kinds are rejected.
    pub async fn ensure(
        &self,
        profile_id: &str,
        spec: &ResolvedCoreUpstream,
    ) -> Result<u16, String> {
        if !spec.kind.requires_core() {
            return Err(format!("{} is not core-backed", spec.kind.as_tag()));
        }

        let want_hash = spec_config_hash(spec);

        let mut guard = self.inner.lock().await;
        if let Some(existing) = guard.get(profile_id) {
            if existing.core.config_hash == want_hash {
                return Ok(existing.core.local_port);
            }
        }
        // Spec changed (or first spawn): tear down any stale core first.
        if let Some(mut old) = guard.remove(profile_id) {
            old.core.shutdown().await;
        }
        let core = XrayCore::spawn(&self.exe, &self.work_dir, spec, want_hash, None).await?;
        let port = core.local_port;
        guard.insert(
            profile_id.to_string(),
            ManagedCore {
                core,
                spec: spec.clone(),
            },
        );
        Ok(port)
    }

    /// Local SOCKS port for a running profile core, if any.
    pub async fn local_port(&self, profile_id: &str) -> Option<u16> {
        self.inner
            .lock()
            .await
            .get(profile_id)
            .map(|c| c.core.local_port)
    }

    /// Stop and remove one profile's core.
    pub async fn remove(&self, profile_id: &str) {
        let core = self.inner.lock().await.remove(profile_id);
        if let Some(mut managed) = core {
            managed.core.shutdown().await;
        }
    }

    /// Stop and remove every running core (async teardown path). Also stops the
    /// health monitor so it doesn't respawn cores mid-teardown.
    pub async fn shutdown_all(&self) {
        self.stop_monitor();
        let mut guard = self.inner.lock().await;
        for (_, mut managed) in guard.drain() {
            managed.core.shutdown().await;
        }
    }

    pub async fn running_count(&self) -> usize {
        self.inner.lock().await.len()
    }

    /// OS PIDs of all running cores. The capture layer must bypass these so the
    /// xray→node connection is not itself re-captured into an infinite loop.
    pub async fn pids(&self) -> Vec<u32> {
        self.inner
            .lock()
            .await
            .values()
            .filter_map(|c| c.core.pid())
            .collect()
    }

    /// One health-check pass: respawn any core whose process has died (crash,
    /// OOM, external kill) on its **same** local port, so the relay's cached
    /// `xray_port` keeps working. Returns the number of cores respawned.
    pub async fn health_check_once(&self) -> usize {
        let mut guard = self.inner.lock().await;
        // Collect dead profiles first (can't respawn while borrowing the map).
        let mut dead: Vec<String> = Vec::new();
        for (id, managed) in guard.iter_mut() {
            if !managed.core.is_alive() {
                dead.push(id.clone());
            }
        }
        let mut respawned = 0;
        for id in dead {
            let Some(managed) = guard.get(&id) else {
                continue;
            };
            let port = managed.core.local_port;
            let spec = managed.spec.clone();
            let hash = managed.core.config_hash.clone();
            tracing::warn!(
                "sockscap: xray core '{id}' ({}) died; respawning on port {port}",
                spec.kind.as_tag()
            );
            match XrayCore::spawn(&self.exe, &self.work_dir, &spec, hash, Some(port)).await {
                Ok(core) => {
                    guard.insert(id.clone(), ManagedCore { core, spec });
                    respawned += 1;
                }
                Err(e) => {
                    tracing::warn!("sockscap: respawn of xray core '{id}' failed: {e}");
                    // Drop the dead entry so a later flow gets a clear "no core"
                    // error rather than dialing a permanently dead port.
                    guard.remove(&id);
                }
            }
        }
        respawned
    }

    /// Start the periodic health monitor (idempotent). Runs until `stop_monitor`
    /// / `shutdown_all` or the process exits. Takes `Arc<Self>` so the task can
    /// call back into the manager.
    pub fn start_monitor(self: &Arc<Self>, interval: Duration) {
        let mut slot = match self.monitor.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if slot.as_ref().is_some_and(|h| !h.is_finished()) {
            return; // already running
        }
        let mgr = Arc::downgrade(self);
        *slot = Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let Some(mgr) = mgr.upgrade() else { break };
                let _ = mgr.health_check_once().await;
            }
        }));
    }

    /// Stop health checks and respawns before releasing the upstreams.
    fn stop_monitor(&self) {
        if let Ok(mut slot) = self.monitor.lock() {
            if let Some(handle) = slot.take() {
                handle.abort();
            }
        }
    }
}

/// Pick a free loopback TCP port for a core's SOCKS inbound.
///
/// Small TOCTOU window (port could be taken before xray binds), acceptable and
/// matches the elevated helper's `pick_free_port`.
fn pick_free_loopback_port() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("pick free port: {e}"))?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

#[cfg(test)]
mod tests {
    use super::*;
    use taomni_sockscap_api::{UpstreamKind, UpstreamParams};

    fn ss_spec() -> ResolvedCoreUpstream {
        ResolvedCoreUpstream {
            kind: UpstreamKind::Shadowsocks,
            host: "1.2.3.4".into(),
            port: 8388,
            secret: "pw".into(),
            uuid: String::new(),
            private_key: String::new(),
            pre_shared_key: String::new(),
            params: UpstreamParams::default(),
        }
    }

    #[test]
    fn config_hash_is_stable_and_port_independent() {
        let spec = ss_spec();
        let a = spec_config_hash(&spec);
        let b = spec_config_hash(&spec);
        assert_eq!(a, b, "same spec → same hash");
        // Hash feeds reuse detection, so config changes must change it.
        let mut changed = spec.clone();
        changed.secret = "different".into();
        assert_ne!(a, spec_config_hash(&changed));
    }

    #[tokio::test]
    async fn ensure_rejects_non_core_kind() {
        let mgr = XrayManager::new(None, std::env::temp_dir().join("xray-test"));
        let mut spec = ss_spec();
        spec.kind = UpstreamKind::Socks5;
        assert!(mgr.ensure("p", &spec).await.is_err());
    }

    #[tokio::test]
    async fn ensure_without_exe_errors_clearly() {
        let mgr = XrayManager::new(None, std::env::temp_dir().join("xray-test"));
        let err = mgr.ensure("p", &ss_spec()).await.unwrap_err();
        assert!(err.contains("xray-core binary not found"));
    }
}
