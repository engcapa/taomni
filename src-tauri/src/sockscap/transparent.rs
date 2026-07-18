//! Transparent capture backends (plan §4.1, §8, §13 Phases 5–7).
//!
//! Unlike the always-available local SOCKS5 backend (`listener.rs`), these
//! intercept traffic without the app configuring a proxy. The Linux backend is
//! fully implementable without a proprietary SDK or signed OS extension: kernel
//! `nftables` REDIRECT (NAT) sends matching TCP flows to a local port where we
//! recover the original destination with `getsockopt(SO_ORIGINAL_DST)` and route
//! them through the same `FlowRouter`. It is `cfg(target_os = "linux")`-gated so
//! it compiles in Linux CI without affecting other platforms' builds.
//!
//! Windows (WinDivert/WFP + a signed driver) and macOS (a notarized
//! NETransparentProxyProvider system extension) genuinely cannot be produced as
//! plain Rust in the main binary — they need external signing/entitlements — so
//! their adapters honestly report "backend not installed" (`is_ready() == false`)
//! rather than faking capture; see the ADRs. The pure rule/parse helpers below
//! are unit-tested on every host.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};

/// nftables ruleset for Linux transparent capture via REDIRECT (plan §7).
///
/// Matches this host's outbound TCP in the configured cgroup v2 slice and
/// redirects it to the local capture port, while hard-bypassing loopback and
/// the capture port itself so the engine can't recurse into its own traffic
/// (plan §6.3 step 1). Rendered to `nft -f -`.
pub fn build_nft_redirect_ruleset(cgroup: Option<&str>, listen_port: u16) -> String {
    // Loopback + our own port are always bypassed so the engine never recurses.
    let bypass = format!(
        "\t\tip daddr 127.0.0.0/8 accept;\n\
         \t\tmeta l4proto tcp tcp dport {port} accept;\n",
        port = listen_port,
    );
    // Global capture matches all outbound TCP; per-cgroup capture matches only
    // the configured cgroup v2 slice (per-app scoping, plan §7).
    let redirect = match cgroup {
        Some(cg) => format!(
            "\t\tsocket cgroupv2 level 1 \"{cg}\" meta l4proto tcp redirect to :{port};\n",
            cg = cg,
            port = listen_port,
        ),
        None => format!(
            "\t\tmeta l4proto tcp redirect to :{port};\n",
            port = listen_port
        ),
    };
    format!(
        "table ip sockscap {{\n\
         \tchain output {{\n\
         \t\ttype nat hook output priority -100; policy accept;\n\
         {bypass}{redirect}\
         \t}}\n\
         }}\n",
    )
}

/// The command to tear the table down on stop / recovery (idempotent).
pub fn nft_flush_command() -> [&'static str; 4] {
    ["delete", "table", "ip", "sockscap"]
}

/// Parse the raw sockaddr returned by `getsockopt(SO_ORIGINAL_DST)` into a
/// `SocketAddr`. Handles IPv4 (`AF_INET`) and IPv6 (`AF_INET6`); the family is
/// the first 2 bytes (host byte order), the port is big-endian.
pub fn parse_original_dst(family: u16, raw: &[u8]) -> Option<SocketAddr> {
    // AF_INET = 2, AF_INET6 = 10 on Linux.
    match family {
        2 => {
            // struct sockaddr_in: family(2) port(2, be) addr(4) ...
            if raw.len() < 8 {
                return None;
            }
            let port = u16::from_be_bytes([raw[2], raw[3]]);
            let ip = Ipv4Addr::new(raw[4], raw[5], raw[6], raw[7]);
            Some(SocketAddr::V4(SocketAddrV4::new(ip, port)))
        }
        10 => {
            // struct sockaddr_in6: family(2) port(2, be) flowinfo(4) addr(16) ...
            if raw.len() < 24 {
                return None;
            }
            let port = u16::from_be_bytes([raw[2], raw[3]]);
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&raw[8..24]);
            let ip = Ipv6Addr::from(octets);
            Some(SocketAddr::V6(SocketAddrV6::new(ip, port, 0, 0)))
        }
        _ => None,
    }
}

/* ------------------------- Linux transparent adapter ----------------------- */
#[cfg(target_os = "linux")]
mod linux {
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    use async_trait::async_trait;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Mutex as AsyncMutex;
    use tokio::sync::Notify;

    use super::{build_nft_redirect_ruleset, nft_flush_command, parse_original_dst};
    use crate::sockscap::capability::{detect, Capabilities};
    use crate::sockscap::capture::CaptureAdapter;
    use crate::sockscap::egress::Endpoint;
    use crate::sockscap::flow::dispatch;
    use crate::sockscap::listener::FlowRouter;

    /// Linux transparent capture: nftables REDIRECT → local port → recover the
    /// original destination via SO_ORIGINAL_DST → route through the FlowRouter.
    pub struct LinuxTransparentAdapter {
        listen_port: u16,
        cgroup: Option<String>,
        router: StdMutex<Option<Arc<FlowRouter>>>,
        task: AsyncMutex<Option<(tokio::task::JoinHandle<()>, Arc<Notify>)>>,
    }

    impl LinuxTransparentAdapter {
        pub fn new(listen_port: u16, cgroup: Option<String>) -> LinuxTransparentAdapter {
            LinuxTransparentAdapter {
                listen_port,
                cgroup,
                router: StdMutex::new(None),
                task: AsyncMutex::new(None),
            }
        }

        pub fn set_router(&self, router: Arc<FlowRouter>) {
            *self.router.lock().unwrap() = Some(router);
        }

        fn apply_nft(&self) -> Result<(), String> {
            let ruleset = build_nft_redirect_ruleset(self.cgroup.as_deref(), self.listen_port);
            let mut child = std::process::Command::new("nft")
                .arg("-f")
                .arg("-")
                .stdin(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("spawn nft: {e}"))?;
            child
                .stdin
                .take()
                .ok_or("nft stdin")?
                .write_all(ruleset.as_bytes())
                .map_err(|e| format!("write nft: {e}"))?;
            let status = child.wait().map_err(|e| format!("nft wait: {e}"))?;
            if !status.success() {
                return Err(format!("nft exited with {status}"));
            }
            Ok(())
        }

        fn flush_nft() {
            let _ = std::process::Command::new("nft")
                .args(nft_flush_command())
                .status();
        }

        /// Recover the pre-NAT destination of a redirected connection.
        fn original_dst(stream: &TcpStream) -> Option<std::net::SocketAddr> {
            let fd = stream.as_raw_fd();
            // SO_ORIGINAL_DST = 80, SOL_IP = 0, SOL_IPV6 = 41.
            let mut buf = [0u8; 28];
            let mut len = buf.len() as libc::socklen_t;
            for (level, opt) in [(0i32, 80i32), (41i32, 80i32)] {
                let rc = unsafe {
                    libc::getsockopt(
                        fd,
                        level,
                        opt,
                        buf.as_mut_ptr() as *mut libc::c_void,
                        &mut len,
                    )
                };
                if rc == 0 {
                    let family = u16::from_ne_bytes([buf[0], buf[1]]);
                    if let Some(sa) = parse_original_dst(family, &buf) {
                        return Some(sa);
                    }
                }
            }
            None
        }

        async fn handle(mut stream: TcpStream, router: Arc<FlowRouter>) {
            let Some(dst) = Self::original_dst(&stream) else {
                return;
            };
            let decision = router.decide(None, Some(dst.ip()), dst.port());
            router.stats.record_decision(decision.action);
            let connector = match router.connector_for(decision.action) {
                Some(c) => c,
                None => return, // BLOCK
            };
            let endpoint = Endpoint::from_ip(dst.ip(), dst.port());
            let _ = dispatch(connector, &endpoint, &mut stream, &router.stats).await;
        }
    }

    #[async_trait]
    impl CaptureAdapter for LinuxTransparentAdapter {
        fn capabilities(&self) -> Capabilities {
            detect()
        }

        fn is_ready(&self) -> bool {
            // Needs CAP_NET_ADMIN and the nft binary; probe cheaply.
            std::process::Command::new("nft")
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }

        async fn install(&self) -> Result<(), String> {
            let router = self
                .router
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "router not configured".to_string())?;
            let listener = TcpListener::bind(("127.0.0.1", self.listen_port))
                .await
                .map_err(|e| format!("bind: {e}"))?;
            self.apply_nft()?;
            let cancel = Arc::new(Notify::new());
            let cancel_task = cancel.clone();
            let handle = tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = cancel_task.notified() => break,
                        accepted = listener.accept() => {
                            if let Ok((stream, _)) = accepted {
                                let router = router.clone();
                                tokio::spawn(LinuxTransparentAdapter::handle(stream, router));
                            } else {
                                break;
                            }
                        }
                    }
                }
            });
            *self.task.lock().await = Some((handle, cancel));
            Ok(())
        }

        async fn uninstall(&self) -> Result<(), String> {
            if let Some((handle, cancel)) = self.task.lock().await.take() {
                cancel.notify_waiters();
                handle.abort();
            }
            // Fail-open: always tear down the nft table to restore direct.
            Self::flush_nft();
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::LinuxTransparentAdapter;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nft_ruleset_per_cgroup_has_redirect_bypass_and_cgroup() {
        let rs = build_nft_redirect_ruleset(Some("sockscap.slice"), 1080);
        assert!(rs.contains("redirect to :1080"));
        assert!(rs.contains("ip daddr 127.0.0.0/8 accept")); // loopback bypass
        assert!(rs.contains("tcp dport 1080 accept")); // don't re-capture ourselves
        assert!(rs.contains("cgroupv2 level 1 \"sockscap.slice\""));
    }

    #[test]
    fn nft_ruleset_global_matches_all_tcp() {
        let rs = build_nft_redirect_ruleset(None, 1080);
        assert!(rs.contains("meta l4proto tcp redirect to :1080"));
        assert!(!rs.contains("cgroupv2"));
        assert!(rs.contains("tcp dport 1080 accept"));
    }

    #[test]
    fn parse_original_dst_ipv4() {
        // family=2, port=443 (0x01BB), addr=93.184.216.34
        let raw = [2u8, 0, 0x01, 0xBB, 93, 184, 216, 34, 0, 0, 0, 0, 0, 0, 0, 0];
        let sa = parse_original_dst(2, &raw).unwrap();
        assert_eq!(sa, "93.184.216.34:443".parse().unwrap());
    }

    #[test]
    fn parse_original_dst_ipv6() {
        let mut raw = vec![10u8, 0, 0x01, 0xBB, 0, 0, 0, 0];
        raw.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        let sa = parse_original_dst(10, &raw).unwrap();
        assert_eq!(sa, "[::1]:443".parse().unwrap());
    }

    #[test]
    fn parse_original_dst_rejects_short_or_unknown() {
        assert!(parse_original_dst(2, &[2, 0, 1]).is_none());
        assert!(parse_original_dst(99, &[0u8; 32]).is_none());
    }
}
