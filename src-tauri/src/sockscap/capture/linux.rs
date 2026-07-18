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
//! Privileged nft rules are applied via on-demand elevation (`pkexec`/`sudo`)
//! so Taomni can run as a normal user and only prompt when Sockscap starts.
//! The local redirect listener stays in-process (unprivileged bind to 127.0.0.1).

use async_trait::async_trait;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
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

    fn can_install_rules() -> bool {
        // Either already elevated, or we can prompt (pkexec/sudo).
        crate::sockscap::elevate::is_currently_elevated()
            || crate::sockscap::elevate::elevation_prompt_available()
    }

    /// Build a single shell script that installs the full nft table (one auth prompt).
    fn build_install_script(listen_port: u16, plan: &CapturePlan) -> String {
        let mut s = String::new();
        s.push_str("command -v nft >/dev/null 2>&1 || { echo 'nft not found' >&2; exit 1; }\n");
        s.push_str(&format!("nft delete table inet {NFT_TABLE} 2>/dev/null || true\n"));
        s.push_str(&format!("nft add table inet {NFT_TABLE}\n"));
        s.push_str(&format!(
            "nft 'add chain inet {NFT_TABLE} {NFT_CHAIN} {{ type route hook output priority 0; policy accept; }}'\n"
        ));
        s.push_str(&format!(
            "nft add rule inet {NFT_TABLE} {NFT_CHAIN} ip daddr 127.0.0.0/8 accept\n"
        ));
        s.push_str(&format!(
            "nft add rule inet {NFT_TABLE} {NFT_CHAIN} ip6 daddr ::1 accept\n"
        ));
        for host in &plan.bypass_hosts {
            if let Ok(ip) = host.parse::<IpAddr>() {
                match ip {
                    IpAddr::V4(v4) => s.push_str(&format!(
                        "nft add rule inet {NFT_TABLE} {NFT_CHAIN} ip daddr {v4} accept\n"
                    )),
                    IpAddr::V6(v6) => s.push_str(&format!(
                        "nft add rule inet {NFT_TABLE} {NFT_CHAIN} ip6 daddr {v6} accept\n"
                    )),
                }
            }
        }
        s.push_str(&format!(
            "nft add rule inet {NFT_TABLE} {NFT_CHAIN} tcp dport {listen_port} ip daddr 127.0.0.0/8 accept\n"
        ));

        let has_global = plan
            .profiles
            .iter()
            .any(|p| p.enabled && p.scope == ProfileScope::Global);
        let has_app = plan.profiles.iter().any(|p| {
            p.enabled
                && matches!(
                    p.scope,
                    ProfileScope::Applications | ProfileScope::RuntimeProcesses
                )
        });

        // Prefer simple global TCP redirect (reliable). Cgroup match is optional.
        if has_global || !has_app || !cgroup_v2_available() {
            s.push_str(&format!(
                "nft add rule inet {NFT_TABLE} {NFT_CHAIN} meta l4proto tcp redirect to {listen_port}\n"
            ));
        } else {
            // Best-effort cgroup: create + match, else global redirect.
            s.push_str("mkdir -p /sys/fs/cgroup/taomni-sockscap 2>/dev/null || true\n");
            s.push_str(&format!(
                "if ! nft add rule inet {NFT_TABLE} {NFT_CHAIN} socket cgroupv2 level 2 \"taomni-sockscap\" meta l4proto tcp redirect to {listen_port} 2>/dev/null; then\n"
            ));
            s.push_str(&format!(
                "  nft add rule inet {NFT_TABLE} {NFT_CHAIN} meta l4proto tcp redirect to {listen_port}\n"
            ));
            s.push_str("fi\n");
        }
        s.push_str("exit 0\n");
        s
    }

    fn install_nft(listen_port: u16, plan: &CapturePlan) -> Result<(), String> {
        let script = Self::build_install_script(listen_port, plan);
        crate::sockscap::elevate::run_script_elevated(&script, "Sockscap capture install")
            .map_err(|e| format!("elevated nft install: {e}"))
    }

    fn uninstall_nft() -> Result<(), String> {
        let script = format!(
            "command -v nft >/dev/null 2>&1 || exit 0\nnft delete table inet {NFT_TABLE} 2>/dev/null || true\nexit 0\n"
        );
        // Uninstall should also elevate so non-root stop works after elevated start.
        crate::sockscap::elevate::run_script_elevated(&script, "Sockscap capture uninstall")
            .map_err(|e| format!("elevated nft uninstall: {e}"))
    }
}

fn cgroup_v2_available() -> bool {
    std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").exists()
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

async fn handle_one(inbound: TcpStream, peer: SocketAddr) -> Result<(), String> {
    let dest = original_dst(&inbound).map_err(|e| format!("SO_ORIGINAL_DST: {e}"))?;
    // Hard safety: never open a loop back into our own listener via redirect.
    if dest.ip().is_loopback() && dest.port() == LISTEN_PORT.load(Ordering::SeqCst) {
        return Err("refusing redirect loop".into());
    }
    tracing::debug!(%peer, %dest, "sockscap linux redirected flow");
    let rt = crate::sockscap::flow::runtime::global_runtime();
    if rt.engines.is_empty() {
        // Fallback DIRECT when no runtime configured (should not happen after start).
        let mut inbound = inbound;
        let mut outbound = TcpStream::connect(dest)
            .await
            .map_err(|e| format!("direct connect {dest}: {e}"))?;
        let _ = copy_bidirectional(&mut inbound, &mut outbound).await;
        return Ok(());
    }
    let _action = rt
        .bridge_inbound(inbound, dest, None, None)
        .await?;
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
        if !Self::can_install_rules() {
            return CaptureOpResult {
                ok: false,
                platform: CapturePlatform::Linux,
                message: format!(
                    "cannot install capture rules: {}",
                    crate::sockscap::elevate::elevation_status_detail()
                ),
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
        let elev = if crate::sockscap::elevate::is_currently_elevated() {
            "already elevated".to_string()
        } else {
            crate::sockscap::elevate::elevation_status_detail()
        };
        CaptureOpResult {
            ok: true,
            platform: CapturePlatform::Linux,
            message: format!("linux nft redirect ready; {elev}"),
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
        // Without nft tools, preflight must fail. With elevation available, ok is possible.
        if !LinuxCaptureAdapter::has_tools() {
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
