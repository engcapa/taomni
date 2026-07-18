//! Windows Sockscap capture plane (plan Phase 5): local SOCKS + WinDivert NAT.
//!
//! - **Global**: divert all outbound TCP (except loopback / capture port) to the
//!   local transparent listener.
//! - **Applications / runtime processes**: same divert path, but only NAT when
//!   the owning PID/exe matches the active selectors (see `windows_pid`).
//! - **Always** also binds the local SOCKS5 front-end for apps that can be
//!   pointed at 127.0.0.1:1080 without transparent capture.
//!
//! Start requires Administrator so WinDivert can load. Missing runtime is
//! installed from bundled `resources/windivert` via UAC
//! (`windows_install::ensure_windivert_installed`).

#![cfg(windows)]

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Notify;

use super::capture::{CaptureAdapter, CaptureMode};
use super::capability::{detect, Capabilities, CaptureSupport};
use super::egress::Endpoint;
use super::flow::dispatch;
use super::listener::{serve_socks5, FlowRouter, LocalCaptureAdapter};
use super::model::{AppSelector, RoutingProfile, Scope};
use super::runtime::DEFAULT_LOCAL_CAPTURE_PORT;
use super::windivert::{ProcessFilter, WinDivertEngine};
use super::windows_install::{
    ensure_windivert_installed, find_bundled_windivert, is_process_elevated,
};
use super::policy::AppIdentity;
use super::{Action, Protocol};

/// Combined Windows capture backend.
pub struct WindowsCaptureAdapter {
    listen_port: u16,
    resource_dir: StdMutex<Option<PathBuf>>,
    router: StdMutex<Option<Arc<FlowRouter>>>,
    profiles: StdMutex<Vec<RoutingProfile>>,
    socks: LocalCaptureAdapter,
    divert: AsyncMutex<Option<WinDivertEngine>>,
    transparent_task: AsyncMutex<Option<(tokio::task::JoinHandle<()>, Arc<Notify>)>>,
}

impl WindowsCaptureAdapter {
    pub fn new() -> WindowsCaptureAdapter {
        WindowsCaptureAdapter {
            listen_port: DEFAULT_LOCAL_CAPTURE_PORT,
            resource_dir: StdMutex::new(None),
            router: StdMutex::new(None),
            profiles: StdMutex::new(Vec::new()),
            socks: LocalCaptureAdapter::new("127.0.0.1", DEFAULT_LOCAL_CAPTURE_PORT),
            divert: AsyncMutex::new(None),
            transparent_task: AsyncMutex::new(None),
        }
    }

    pub fn set_resource_dir(&self, dir: PathBuf) {
        *self.resource_dir.lock().unwrap() = Some(dir);
    }

    pub fn set_router(&self, router: Arc<FlowRouter>) {
        *self.router.lock().unwrap() = Some(router.clone());
        self.socks.set_router(router);
    }

    pub fn set_profiles(&self, profiles: Vec<RoutingProfile>) {
        *self.profiles.lock().unwrap() = profiles;
    }

    pub fn bound_port(&self) -> Option<u16> {
        self.socks.bound_port().or(Some(self.listen_port))
    }

    fn build_process_filter(profiles: &[RoutingProfile]) -> ProcessFilter {
        let mut has_global = false;
        let mut exes: HashSet<String> = HashSet::new();
        let mut pids: HashSet<u32> = HashSet::new();
        for p in profiles.iter().filter(|p| p.enabled) {
            match p.scope {
                Scope::Global => has_global = true,
                Scope::Applications => {
                    for s in &p.app_selectors {
                        if let AppSelector::WindowsExecutable(path) = s {
                            let lower = path.replace('/', "\\").to_ascii_lowercase();
                            exes.insert(lower.clone());
                            if let Some(name) = std::path::Path::new(&lower)
                                .file_name()
                                .and_then(|n| n.to_str())
                            {
                                exes.insert(name.to_string());
                            }
                        }
                    }
                }
                Scope::RuntimeProcesses => {
                    for rp in &p.runtime_processes {
                        pids.insert(rp.pid);
                    }
                }
            }
        }
        if has_global || (exes.is_empty() && pids.is_empty()) {
            // Global profile or nothing specific → capture all TCP (policy still
            // decides DIRECT/PROXY/BLOCK per destination).
            ProcessFilter::All
        } else if !pids.is_empty() && exes.is_empty() {
            ProcessFilter::Pids(pids)
        } else if !exes.is_empty() && pids.is_empty() {
            ProcessFilter::Executables(exes)
        } else {
            // Mixed app + PID: treat as All and let policy drop non-matches by
            // only applying non-global profiles when identity matches (divert
            // more, decide carefully in the transparent handler).
            ProcessFilter::All
        }
    }

    fn bundle_dir(&self) -> Result<PathBuf, String> {
        let hint = self.resource_dir.lock().unwrap().clone();
        find_bundled_windivert(hint.as_deref()).ok_or_else(|| {
            "WinDivert runtime not found in app resources (expected resources/windivert/WinDivert.dll)"
                .into()
        })
    }
}

impl Default for WindowsCaptureAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CaptureAdapter for WindowsCaptureAdapter {
    fn capabilities(&self) -> Capabilities {
        let mut caps = detect();
        caps.global_capture = CaptureSupport::Supported;
        caps.app_capture = CaptureSupport::Supported;
        caps.pid_capture = CaptureSupport::Supported;
        caps.child_follow = true;
        caps.requires_privilege = true;
        caps.notes.insert(
            0,
            format!(
                "Windows transparent capture via WinDivert + local SOCKS on 127.0.0.1:{} (Administrator required to Start)",
                self.listen_port
            ),
        );
        caps
    }

    fn is_ready(&self) -> bool {
        // Ready once the redistributable is bundled; install/elevation happens
        // in install() so Start can trigger UAC.
        find_bundled_windivert(self.resource_dir.lock().unwrap().as_deref()).is_some()
            || super::windows_install::windivert_files_installed()
    }

    fn mode(&self) -> CaptureMode {
        CaptureMode::WindowsWindivert
    }

    async fn install(&self) -> Result<(), String> {
        let bundle = self.bundle_dir()?;
        ensure_windivert_installed(&bundle)?;
        if !is_process_elevated() {
            return Err(
                "Administrator privileges required for transparent capture. \
                 Allow the UAC prompt to install the driver, then click Start again \
                 (or restart Taomni as Administrator)."
                    .into(),
            );
        }

        // Smoke-open after install.
        super::windivert::smoke_open(Some(&bundle))?;

        let router = self
            .router
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "router not configured".to_string())?;
        let profiles = self.profiles.lock().unwrap().clone();
        let filter = Self::build_process_filter(&profiles);

        // SOCKS front-end (explicit proxy clients).
        self.socks.set_router(router.clone());
        // Bind may fail if port busy — try install socks after divert listener.
        // Transparent listener shares the same port: only ONE bind. Prefer
        // transparent accept + SOCKS on same port is impossible. Strategy:
        // transparent TCP accept handles NAT'd flows; SOCKS needs separate port
        // OR only transparent. Spec: local SOCKS on 1080 AND transparent.
        // WinDivert redirects to 1080; SOCKS also 1080 — conflict!
        //
        // Fix: transparent listener on 1080 receives NAT connections (raw TCP,
        // not SOCKS). Explicit SOCKS clients also connect to 1080 — they send
        // SOCKS greeting. Detect protocol: if first byte 0x05 treat as SOCKS,
        // else treat as transparent original-dest flow via conntrack.
        let listener = TcpListener::bind(("127.0.0.1", self.listen_port))
            .await
            .map_err(|e| format!("bind 127.0.0.1:{}: {e}", self.listen_port))?;

        let engine = WinDivertEngine::start(self.listen_port, Some(&bundle), filter)?;
        let conntrack = engine.conntrack.clone();
        *self.divert.lock().await = Some(engine);

        let cancel = Arc::new(Notify::new());
        let cancel_t = cancel.clone();
        let port = self.listen_port;
        let handle = tokio::spawn(async move {
            serve_mixed(listener, router, conntrack, cancel_t, port).await;
        });
        *self.transparent_task.lock().await = Some((handle, cancel));
        Ok(())
    }

    async fn uninstall(&self) -> Result<(), String> {
        if let Some((handle, cancel)) = self.transparent_task.lock().await.take() {
            cancel.notify_waiters();
            handle.abort();
        }
        if let Some(engine) = self.divert.lock().await.take() {
            engine.stop();
        }
        let _ = self.socks.uninstall().await;
        Ok(())
    }
}

/// Accept loop: SOCKS5 clients (VER=5) vs transparent NAT'd TCP (conntrack).
async fn serve_mixed(
    listener: TcpListener,
    router: Arc<FlowRouter>,
    conntrack: super::windivert::ConnTrack,
    cancel: Arc<Notify>,
    _local_port: u16,
) {
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        let router = router.clone();
                        let conntrack = conntrack.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_mixed(stream, peer, router, conntrack).await {
                                tracing::debug!("sockscap windows conn: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!("sockscap windows accept failed: {e}");
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_mixed(
    mut stream: TcpStream,
    peer: SocketAddr,
    router: Arc<FlowRouter>,
    conntrack: super::windivert::ConnTrack,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Peek first byte to distinguish SOCKS5 (0x05) from transparent TCP.
    let mut first = [0u8; 1];
    stream.read_exact(&mut first).await.map_err(|e| e.to_string())?;
    if first[0] == 0x05 {
        // Rebuild SOCKS by prepending the byte — hand-roll a minimal path:
        // we already consumed 0x05; continue SOCKS handshake.
        return handle_socks_after_ver(&mut stream, router).await;
    }

    // Transparent: recover original destination from conntrack by peer port.
    let sport = peer.port();
    let info = conntrack
        .lock()
        .unwrap()
        .get(&sport)
        .cloned()
        .ok_or_else(|| format!("no conntrack for sport {sport}"))?;

    let app = AppIdentity {
        windows_exe: info.exe.clone(),
        pid: info.pid,
        process_start_time: info.pid.map(|p| format!("pid:{p}")),
        ..Default::default()
    };
    if let Some(exe) = &info.exe {
        router.stats.record_app(exe.clone());
    }

    let decision = router.decide_for_app(
        &app,
        None,
        Some(IpAddr::V4(info.dst)),
        info.dport,
    );
    router.stats.record_decision(decision.action);
    // Re-inject first byte into a buffered path — we already read 1 byte of
    // payload; for SYN-only accepts the app sends data after connect. Put the
    // byte back by writing to a chain: use a custom prefix stream.
    let endpoint = Endpoint::from_ip(IpAddr::V4(info.dst), info.dport);
    let connector = match router.connector_for(decision.action) {
        Some(c) => c,
        None => return Ok(()), // BLOCK
    };

    // Prefix stream with the already-read byte.
    let mut prefixed = PrefixedStream {
        prefix: Some(first[0]),
        inner: stream,
    };
    dispatch(connector, &endpoint, &mut prefixed, &router.stats).await?;
    Ok(())
}

/// SOCKS5 after the version byte 0x05 was consumed.
async fn handle_socks_after_ver(
    stream: &mut TcpStream,
    router: Arc<FlowRouter>,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut nmethods = [0u8; 1];
    stream.read_exact(&mut nmethods).await.map_err(|e| e.to_string())?;
    let mut methods = vec![0u8; nmethods[0] as usize];
    stream.read_exact(&mut methods).await.map_err(|e| e.to_string())?;
    stream.write_all(&[0x05, 0x00]).await.map_err(|e| e.to_string())?;

    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await.map_err(|e| e.to_string())?;
    if req[1] != 0x01 {
        let _ = stream.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err("unsupported SOCKS command".into());
    }
    let (host, ip) = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            (None, Some(IpAddr::from(a)))
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(|e| e.to_string())?;
            let mut h = vec![0u8; len[0] as usize];
            stream.read_exact(&mut h).await.map_err(|e| e.to_string())?;
            (Some(String::from_utf8_lossy(&h).to_string()), None)
        }
        0x04 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            (None, Some(IpAddr::from(a)))
        }
        _ => return Err("bad ATYP".into()),
    };
    let mut portb = [0u8; 2];
    stream.read_exact(&mut portb).await.map_err(|e| e.to_string())?;
    let port = u16::from_be_bytes(portb);

    let decision = router.decide(host.as_deref(), ip, port);
    router.stats.record_decision(decision.action);
    let connector = match router.connector_for(decision.action) {
        Some(c) => c,
        None => {
            let _ = stream.write_all(&[0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Ok(());
        }
    };
    let endpoint = match (&host, ip) {
        (Some(h), _) => Endpoint::from_host(h.clone(), port),
        (None, Some(ip)) => Endpoint::from_ip(ip, port),
        _ => return Err("no target".into()),
    };
    let _ = stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
    dispatch(connector, &endpoint, stream, &router.stats).await?;
    Ok(())
}

/// TcpStream wrapper that yields one prefix byte then the inner stream.
struct PrefixedStream {
    prefix: Option<u8>,
    inner: TcpStream,
}

use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

impl AsyncRead for PrefixedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if let Some(b) = self.prefix.take() {
            if buf.remaining() > 0 {
                buf.put_slice(&[b]);
                return Poll::Ready(Ok(()));
            }
            self.prefix = Some(b);
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for PrefixedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
