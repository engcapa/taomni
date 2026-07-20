//! Windows Sockscap capture plane (plan Phase 5) — main process side.
//!
//! The **main Taomni process stays non-elevated**. Transparent capture runs in
//! elevated `sockscap-helper.exe` (UAC only for that helper). The main process:
//! - Spawns the helper via `runas` and talks JSON-lines over a named pipe
//! - Binds local SOCKS5 + transparent accept on 127.0.0.1:1080 (no admin)
//! - Queries the helper for conntrack (original dest + PID/exe) per flow

#![cfg(windows)]

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use async_trait::async_trait;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Notify;

use super::capture::{CaptureAdapter, CaptureMode};
use super::capability::{detect, Capabilities, CaptureSupport};
use super::egress::Endpoint;
use super::flow::dispatch;
use super::helper::ProcessFilterSpec;
use super::listener::FlowRouter;
use super::model::{AppSelector, RoutingProfile, Scope};
use super::policy::AppIdentity;
use super::runtime::DEFAULT_LOCAL_CAPTURE_PORT;
use super::windows_helper_client::HelperClient;
use super::windows_install::find_bundled_windivert;

/// Combined Windows capture backend (helper-backed WinDivert + local accept).
pub struct WindowsCaptureAdapter {
    listen_port: u16,
    resource_dir: StdMutex<Option<PathBuf>>,
    router: StdMutex<Option<Arc<FlowRouter>>>,
    profiles: StdMutex<Vec<RoutingProfile>>,
    helper: AsyncMutex<Option<Arc<HelperClient>>>,
    accept_task: AsyncMutex<Option<(tokio::task::JoinHandle<()>, Arc<Notify>)>>,
    hb_task: AsyncMutex<Option<tokio::task::JoinHandle<()>>>,
}

impl WindowsCaptureAdapter {
    pub fn new() -> WindowsCaptureAdapter {
        WindowsCaptureAdapter {
            listen_port: DEFAULT_LOCAL_CAPTURE_PORT,
            resource_dir: StdMutex::new(None),
            router: StdMutex::new(None),
            profiles: StdMutex::new(Vec::new()),
            helper: AsyncMutex::new(None),
            accept_task: AsyncMutex::new(None),
            hb_task: AsyncMutex::new(None),
        }
    }

    pub fn set_resource_dir(&self, dir: PathBuf) {
        *self.resource_dir.lock().unwrap() = Some(dir);
    }

    pub fn set_router(&self, router: Arc<FlowRouter>) {
        *self.router.lock().unwrap() = Some(router);
    }

    pub fn set_profiles(&self, profiles: Vec<RoutingProfile>) {
        *self.profiles.lock().unwrap() = profiles;
    }

    pub fn bound_port(&self) -> Option<u16> {
        Some(self.listen_port)
    }

    fn build_filter_spec(profiles: &[RoutingProfile]) -> ProcessFilterSpec {
        let mut has_global = false;
        let mut paths: Vec<String> = Vec::new();
        let mut pids: Vec<u32> = Vec::new();
        for p in profiles.iter().filter(|p| p.enabled) {
            match p.scope {
                Scope::Global => has_global = true,
                Scope::Applications => {
                    for s in &p.app_selectors {
                        if let AppSelector::WindowsExecutable(path) = s {
                            let norm = path.replace('/', "\\").to_ascii_lowercase();
                            // Full path + basename so WinDivert filter still
                            // matches when install dir differs (e.g. Edge
                            // Program Files vs Program Files (x86)).
                            paths.push(norm.clone());
                            if let Some(name) = std::path::Path::new(&norm)
                                .file_name()
                                .and_then(|n| n.to_str())
                            {
                                paths.push(name.to_string());
                            }
                        }
                    }
                }
                Scope::RuntimeProcesses => {
                    for rp in &p.runtime_processes {
                        pids.push(rp.pid);
                    }
                }
            }
        }
        if has_global || (paths.is_empty() && pids.is_empty()) {
            ProcessFilterSpec::All
        } else if !pids.is_empty() && paths.is_empty() {
            ProcessFilterSpec::Pids { pids }
        } else if !paths.is_empty() && pids.is_empty() {
            ProcessFilterSpec::Executables { paths }
        } else {
            ProcessFilterSpec::All
        }
    }

    fn bundle_dir(&self) -> Result<PathBuf, String> {
        let hint = self.resource_dir.lock().unwrap().clone();
        find_bundled_windivert(hint.as_deref()).ok_or_else(|| {
            "WinDivert runtime not found in app resources (expected windivert/WinDivert.dll)"
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
        // Main process does NOT need admin; only the helper does.
        caps.requires_privilege = false;
        caps.notes.insert(
            0,
            "Transparent capture runs in elevated sockscap-helper (UAC on Start only). \
             Main Taomni stays non-elevated. Local SOCKS also on 127.0.0.1:1080."
                .into(),
        );
        caps
    }

    fn is_ready(&self) -> bool {
        find_bundled_windivert(self.resource_dir.lock().unwrap().as_deref()).is_some()
            || HelperClient::find_helper_exe().is_some()
            || super::windows_install::windivert_files_installed()
    }

    fn mode(&self) -> CaptureMode {
        CaptureMode::WindowsWindivert
    }

    async fn install(&self) -> Result<(), String> {
        let bundle = self.bundle_dir()?;
        let resource_hint = self.resource_dir.lock().unwrap().clone();

        // Spawn elevated helper (UAC). Main process remains non-elevated.
        let client = HelperClient::spawn_elevated(
            resource_hint.as_deref().or(Some(bundle.as_path())),
        )?;

        let profiles = self.profiles.lock().unwrap().clone();
        let filter = Self::build_filter_spec(&profiles);
        tracing::info!(
            "sockscap: install_capture port={} filter={filter:?} windivert={}",
            self.listen_port,
            bundle.display()
        );
        client.install_capture("active", self.listen_port, filter, &bundle)?;

        let router = self
            .router
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "router not configured".to_string())?;

        // Accept SOCKS + transparent TCP in the main process (no admin).
        let listener = TcpListener::bind(("127.0.0.1", self.listen_port))
            .await
            .map_err(|e| format!("bind 127.0.0.1:{}: {e}", self.listen_port))?;

        let helper = Arc::new(client);
        let cancel = Arc::new(Notify::new());
        let cancel_t = cancel.clone();
        let helper_accept = helper.clone();
        let handle = tokio::spawn(async move {
            serve_mixed(listener, router, helper_accept, cancel_t).await;
        });
        *self.accept_task.lock().await = Some((handle, cancel));

        // Heartbeat so the helper fails open if the main process dies.
        let helper_hb = helper.clone();
        let hb = tokio::spawn(async move {
            let mut n = 1u64;
            loop {
                tokio::time::sleep(Duration::from_secs(3)).await;
                if helper_hb.heartbeat(n).is_err() {
                    break;
                }
                n = n.wrapping_add(1);
            }
        });
        *self.hb_task.lock().await = Some(hb);
        *self.helper.lock().await = Some(helper);
        Ok(())
    }

    async fn uninstall(&self) -> Result<(), String> {
        if let Some(h) = self.hb_task.lock().await.take() {
            h.abort();
        }
        if let Some((handle, cancel)) = self.accept_task.lock().await.take() {
            cancel.notify_waiters();
            handle.abort();
        }
        if let Some(client) = self.helper.lock().await.take() {
            let _ = client.revoke_capture();
            client.shutdown();
        }
        Ok(())
    }
}

async fn serve_mixed(
    listener: TcpListener,
    router: Arc<FlowRouter>,
    helper: Arc<HelperClient>,
    cancel: Arc<Notify>,
) {
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        let router = router.clone();
                        let helper = helper.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_mixed(stream, peer, router, helper).await {
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
    helper: Arc<HelperClient>,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut first = [0u8; 1];
    stream.read_exact(&mut first).await.map_err(|e| e.to_string())?;
    if first[0] == 0x05 {
        return handle_socks_after_ver(&mut stream, router).await;
    }

    let sport = peer.port();
    // Blocking lookup on helper pipe — offload to spawn_blocking.
    let info = tokio::task::spawn_blocking(move || helper.lookup_conntrack(sport))
        .await
        .map_err(|e| e.to_string())??
        .ok_or_else(|| format!("no conntrack for sport {sport}"))?;

    let dst: IpAddr = info
        .dst
        .parse()
        .map_err(|e| format!("bad dst {}: {e}", info.dst))?;
    let app = AppIdentity {
        windows_exe: info.exe.clone(),
        pid: info.pid,
        process_start_time: info.pid.map(|p| format!("pid:{p}")),
        ..Default::default()
    };
    if let Some(exe) = &info.exe {
        router.stats.record_app(exe.clone());
    }

    let decision = router.decide_for_app(&app, None, Some(dst), info.dport);
    router.stats.record_decision(decision.action);
    let connector = match router.connector_for(decision.action) {
        Some(c) => c,
        None => return Ok(()),
    };
    let endpoint = Endpoint::from_ip(dst, info.dport);
    let mut prefixed = PrefixedStream {
        prefix: Some(first[0]),
        inner: stream,
    };
    dispatch(connector, &endpoint, &mut prefixed, &router.stats).await?;
    Ok(())
}

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
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
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
            let _ = stream
                .write_all(&[0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Ok(());
        }
    };
    let endpoint = match (&host, ip) {
        (Some(h), _) => Endpoint::from_host(h.clone(), port),
        (None, Some(ip)) => Endpoint::from_ip(ip, port),
        _ => return Err("no target".into()),
    };
    let _ = stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await;
    dispatch(connector, &endpoint, stream, &router.stats).await?;
    Ok(())
}

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
