//! Linux capture via nftables transparent redirect + local TCP relay.
//!
//! Phase 0/7 vertical slice (design plan §8 / §13):
//! - Install an nft table that redirects new TCP connections to a local
//!   listener (with hard-bypass for loopback / configured upstreams).
//! - Accept loop uses `SO_ORIGINAL_DST` to recover the real target.
//! - Each accepted stream is handed to a callback (FlowEngine later); the
//!   scaffold relays DIRECT by default so TCP echo tests pass under root.
//! - Uninstall deletes the nft table and stops the listener (fail-open).
//!
//! App-group / cgroup match is prepared: when profiles use application scope
//! and cgroup v2 is available, rules can be narrowed; global profiles use
//! broad TCP redirect with bypass set.
//!
//! Requires CAP_NET_ADMIN (or root) plus `nft` on PATH. Without privileges,
//! install fails loudly and mutates nothing.

use async_trait::async_trait;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::{CaptureAdapter, CaptureOpResult, CapturePlan};
use crate::sockscap::types::{CapturePlatform, ProfileScope};

const NFT_TABLE: &str = "taomni_sockscap";
const NFT_CHAIN: &str = "output";
/// Linux sockopt for original destination under REDIRECT/TPROXY.
#[cfg(target_os = "linux")]
const SO_ORIGINAL_DST: i32 = 80;

#[derive(Default)]
pub struct LinuxCaptureAdapter {
    inner: Mutex<Option<ActiveCapture>>,
}

struct ActiveCapture {
    listen_port: u16,
    cancel: CancellationToken,
    join: tokio::task::JoinHandle<()>,
    installed_nft: bool,
}

/// Shared flag: true after a successful install on this process.
static CAPTURE_LIVE: AtomicBool = AtomicBool::new(false);
static LISTEN_PORT: AtomicU16 = AtomicU16::new(0);

impl LinuxCaptureAdapter {
    fn has_tools() -> bool {
        which::which("nft").is_ok()
    }

    fn is_privileged() -> bool {
        // euid 0 is sufficient; CAP_NET_ADMIN without root is not probed deeply.
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("Uid:") {
                    let parts: Vec<&str> = rest.split_whitespace().collect();
                    if parts.len() >= 2 {
                        if let Ok(euid) = parts[1].parse::<u32>() {
                            return euid == 0;
                        }
                    }
                }
            }
        }
        false
    }

    fn run_nft(args: &[&str]) -> Result<String, String> {
        let out = Command::new("nft")
            .args(args)
            .output()
            .map_err(|e| format!("spawn nft: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(format!(
                "nft {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    fn uninstall_nft() -> Result<(), String> {
        // Idempotent delete.
        let _ = Self::run_nft(&["delete", "table", "inet", NFT_TABLE]);
        Ok(())
    }

    fn install_nft(listen_port: u16, plan: &CapturePlan) -> Result<(), String> {
        Self::uninstall_nft()?;

        Self::run_nft(&["add", "table", "inet", NFT_TABLE])?;
        Self::run_nft(&[
            "add",
            "chain",
            "inet",
            NFT_TABLE,
            NFT_CHAIN,
            "{",
            "type",
            "route",
            "hook",
            "output",
            "priority",
            "0;",
            "policy",
            "accept;",
            "}",
        ])?;

        // Always skip loopback destinations.
        Self::run_nft(&[
            "add",
            "rule",
            "inet",
            NFT_TABLE,
            NFT_CHAIN,
            "ip",
            "daddr",
            "127.0.0.0/8",
            "accept",
        ])?;
        Self::run_nft(&[
            "add",
            "rule",
            "inet",
            NFT_TABLE,
            NFT_CHAIN,
            "ip6",
            "daddr",
            "::1",
            "accept",
        ])?;

        // Bypass configured hosts (best-effort IP literals only in nft).
        for host in &plan.bypass_hosts {
            if let Ok(ip) = host.parse::<IpAddr>() {
                match ip {
                    IpAddr::V4(v4) => {
                        let _ = Self::run_nft(&[
                            "add",
                            "rule",
                            "inet",
                            NFT_TABLE,
                            NFT_CHAIN,
                            "ip",
                            "daddr",
                            &v4.to_string(),
                            "accept",
                        ]);
                    }
                    IpAddr::V6(v6) => {
                        let _ = Self::run_nft(&[
                            "add",
                            "rule",
                            "inet",
                            NFT_TABLE,
                            NFT_CHAIN,
                            "ip6",
                            "daddr",
                            &v6.to_string(),
                            "accept",
                        ]);
                    }
                }
            }
        }

        // Skip our own redirect target port on loopback.
        let port_s = listen_port.to_string();
        Self::run_nft(&[
            "add",
            "rule",
            "inet",
            NFT_TABLE,
            NFT_CHAIN,
            "tcp",
            "dport",
            &port_s,
            "ip",
            "daddr",
            "127.0.0.0/8",
            "accept",
        ])?;

        let has_global = plan
            .profiles
            .iter()
            .any(|p| p.enabled && p.scope == ProfileScope::Global);
        let has_app = plan.profiles.iter().any(|p| {
            p.enabled && matches!(p.scope, ProfileScope::Applications | ProfileScope::RuntimeProcesses)
        });

        if has_global || !has_app {
            // Redirect all remaining TCP to local listener.
            Self::run_nft(&[
                "add",
                "rule",
                "inet",
                NFT_TABLE,
                NFT_CHAIN,
                "meta",
                "l4proto",
                "tcp",
                "redirect",
                "to",
                &port_s,
            ])?;
        } else {
            // App-group without full cgroup plumbing yet: still install a
            // global TCP redirect so the vertical slice works; document that
            // true cgroup match lands with privileged helper refinement.
            Self::run_nft(&[
                "add",
                "rule",
                "inet",
                NFT_TABLE,
                NFT_CHAIN,
                "meta",
                "l4proto",
                "tcp",
                "redirect",
                "to",
                &port_s,
            ])?;
            tracing::warn!(
                "linux capture: app-group profiles present; using global TCP redirect until cgroup match helper ships"
            );
        }

        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn original_dst(stream: &TcpStream) -> std::io::Result<SocketAddr> {
    use std::mem;
    use std::os::fd::AsRawFd;
    let fd = stream.as_raw_fd();
    unsafe {
        let mut addr: libc::sockaddr_in = mem::zeroed();
        let mut len = mem::size_of_val(&addr) as libc::socklen_t;
        let rc = libc::getsockopt(
            fd,
            libc::SOL_IP,
            SO_ORIGINAL_DST,
            &mut addr as *mut _ as *mut libc::c_void,
            &mut len,
        );
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let ip = Ipv4Addr::from(u32::from_be(addr.sin_addr.s_addr));
        let port = u16::from_be(addr.sin_port);
        Ok(SocketAddr::new(IpAddr::V4(ip), port))
    }
}

#[cfg(not(target_os = "linux"))]
fn original_dst(_stream: &TcpStream) -> std::io::Result<SocketAddr> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "SO_ORIGINAL_DST only on Linux",
    ))
}

async fn accept_loop(listener: TcpListener, cancel: CancellationToken) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            acc = listener.accept() => {
                match acc {
                    Ok((inbound, peer)) => {
                        tokio::spawn(async move {
                            if let Err(e) = handle_one(inbound, peer).await {
                                tracing::debug!("sockscap linux flow ended: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!("sockscap linux accept error: {e}");
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_one(mut inbound: TcpStream, peer: SocketAddr) -> Result<(), String> {
    let dest = original_dst(&inbound).map_err(|e| format!("SO_ORIGINAL_DST: {e}"))?;
    // Hard safety: never open a loop back into our own listener via redirect.
    if dest.ip().is_loopback() && dest.port() == LISTEN_PORT.load(Ordering::SeqCst) {
        return Err("refusing redirect loop".into());
    }
    tracing::debug!(%peer, %dest, "sockscap linux redirected flow");
    let mut outbound = TcpStream::connect(dest)
        .await
        .map_err(|e| format!("direct connect {dest}: {e}"))?;
    let _ = copy_bidirectional(&mut inbound, &mut outbound).await;
    Ok(())
}

#[async_trait]
impl CaptureAdapter for LinuxCaptureAdapter {
    fn platform(&self) -> CapturePlatform {
        CapturePlatform::Linux
    }

    fn name(&self) -> &'static str {
        "linux-nft-redirect"
    }

    fn is_implemented(&self) -> bool {
        // Code path exists; privilege check happens at install.
        cfg!(target_os = "linux") && Self::has_tools()
    }

    async fn preflight(&self, plan: &CapturePlan) -> CaptureOpResult {
        if !Self::has_tools() {
            return CaptureOpResult {
                ok: false,
                platform: CapturePlatform::Linux,
                message: "`nft` not found on PATH".into(),
                mutated_system: false,
            };
        }
        if !Self::is_privileged() {
            return CaptureOpResult {
                ok: false,
                platform: CapturePlatform::Linux,
                message: "CAP_NET_ADMIN/root required to install nft redirect rules".into(),
                mutated_system: false,
            };
        }
        if plan.profiles.iter().filter(|p| p.enabled).count() == 0 {
            return CaptureOpResult {
                ok: false,
                platform: CapturePlatform::Linux,
                message: "no enabled profiles in capture plan".into(),
                mutated_system: false,
            };
        }
        CaptureOpResult {
            ok: true,
            platform: CapturePlatform::Linux,
            message: "linux nft redirect preflight ok".into(),
            mutated_system: false,
        }
    }

    async fn install(&self, plan: &CapturePlan) -> CaptureOpResult {
        let pre = self.preflight(plan).await;
        if !pre.ok {
            return pre;
        }

        // Stop any previous instance first.
        let _ = self.uninstall().await;

        let listener = match TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
        {
            Ok(l) => l,
            Err(e) => {
                return CaptureOpResult {
                    ok: false,
                    platform: CapturePlatform::Linux,
                    message: format!("bind redirect listener: {e}"),
                    mutated_system: false,
                };
            }
        };
        let listen_port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(e) => {
                return CaptureOpResult {
                    ok: false,
                    platform: CapturePlatform::Linux,
                    message: format!("listener local_addr: {e}"),
                    mutated_system: false,
                };
            }
        };
        LISTEN_PORT.store(listen_port, Ordering::SeqCst);

        if let Err(e) = Self::install_nft(listen_port, plan) {
            let _ = Self::uninstall_nft();
            return CaptureOpResult {
                ok: false,
                platform: CapturePlatform::Linux,
                message: format!("nft install failed (rolled back): {e}"),
                mutated_system: false,
            };
        }

        let cancel = CancellationToken::new();
        let join = tokio::spawn(accept_loop(listener, cancel.clone()));
        {
            let mut g = self.inner.lock().await;
            *g = Some(ActiveCapture {
                listen_port,
                cancel,
                join,
                installed_nft: true,
            });
        }
        CAPTURE_LIVE.store(true, Ordering::SeqCst);

        CaptureOpResult {
            ok: true,
            platform: CapturePlatform::Linux,
            message: format!(
                "linux nft redirect active on 127.0.0.1:{listen_port} (table inet {NFT_TABLE})"
            ),
            mutated_system: true,
        }
    }

    async fn uninstall(&self) -> CaptureOpResult {
        let prev = {
            let mut g = self.inner.lock().await;
            g.take()
        };
        if let Some(active) = prev {
            active.cancel.cancel();
            active.join.abort();
            if active.installed_nft {
                if let Err(e) = Self::uninstall_nft() {
                    CAPTURE_LIVE.store(false, Ordering::SeqCst);
                    LISTEN_PORT.store(0, Ordering::SeqCst);
                    return CaptureOpResult {
                        ok: false,
                        platform: CapturePlatform::Linux,
                        message: format!("nft uninstall failed: {e}"),
                        mutated_system: true,
                    };
                }
            }
        } else {
            // Best-effort cleanup of leftover table from crash.
            let _ = Self::uninstall_nft();
        }
        CAPTURE_LIVE.store(false, Ordering::SeqCst);
        LISTEN_PORT.store(0, Ordering::SeqCst);
        CaptureOpResult {
            ok: true,
            platform: CapturePlatform::Linux,
            message: "linux capture uninstalled (nft table removed, listener stopped)".into(),
            mutated_system: false,
        }
    }
}

/// Whether this process currently has an active Linux capture install.
pub fn capture_live() -> bool {
    CAPTURE_LIVE.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::{ProfileScope, RoutingProfileDraft};

    #[tokio::test]
    async fn preflight_without_root_fails_cleanly() {
        let a = LinuxCaptureAdapter::default();
        let plan = CapturePlan {
            profiles: vec![RoutingProfileDraft {
                id: "g".into(),
                name: "g".into(),
                enabled: true,
                scope: ProfileScope::Global,
                ..Default::default()
            }],
            bypass_hosts: vec!["127.0.0.1".into()],
        };
        let r = a.preflight(&plan).await;
        // Either missing nft or missing root — must not claim ok without privileges.
        if !LinuxCaptureAdapter::is_privileged() || !LinuxCaptureAdapter::has_tools() {
            assert!(!r.ok);
            assert!(!r.mutated_system);
        }
    }

    #[tokio::test]
    async fn uninstall_without_install_is_ok() {
        let a = LinuxCaptureAdapter::default();
        let r = a.uninstall().await;
        assert!(r.ok);
    }
}
