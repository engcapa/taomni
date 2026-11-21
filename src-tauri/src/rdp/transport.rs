//! Transport selection for an RDP session.
//!
//! Three modes converge on the same `Box<dyn AsyncRead + AsyncWrite + Unpin + Send>`:
//!
//! - **Direct TCP** — same DNS / IP-version logic as SSH and VNC.
//! - **HTTP CONNECT or SOCKS5 proxy / SSH jump host** — delegated to
//!   [`crate::terminal::network::establish_transport`], which already
//!   speaks both proxy protocols with auth, and
//!   [`crate::terminal::ssh::build_ssh_transport`] for SSH jump hosts.
//! - **RD Gateway (MS-TSGU)** — a hand-rolled RPC-over-HTTPS twin-channel
//!   wrapper in [`taomni_rdp_client_engine::gateway`] that exposes its stream as
//!   `AsyncRead + AsyncWrite`.
//!
//! Higher layers (X.224 negotiation, TLS upgrade, MCS, …) treat the
//! transport opaquely.

use std::fmt::Display;
use std::future::Future;
use std::net::SocketAddr;

use std::sync::Arc;

use taomni_rdp_client_engine::transport::{RdpConnector, RdpTransport};
use taomni_rdp_client_engine::{GatewayOpt, gateway};
use tokio::net::TcpStream;

use crate::terminal::network::{NetworkSettings, establish_transport};
use crate::terminal::ssh::build_ssh_transport;

const DIRECT_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const ROUTED_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const GATEWAY_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// Resolve each stream using the same route on the first connect and after a resize.
pub(super) fn connector(
    host: String,
    port: u16,
    network: Option<NetworkSettings>,
    gateway: Option<GatewayOpt>,
) -> RdpConnector {
    Arc::new(move || {
        let host = host.clone();
        let network = network.clone();
        let gateway = gateway.clone();
        Box::pin(
            async move { open_transport(&host, port, network.as_ref(), gateway.as_ref()).await },
        )
    })
}

/// Open an RDP transport.
///
/// Selection rules:
///
/// 1. If `gateway` is `Some`, route through the RD Gateway. The host/port
///    arguments are the *target* RDP server inside the gateway tunnel.
/// 2. Else, if `network` indicates a non-`none` route (`http` / `socks5` /
///    `ssh-tunnel`), route through the matching shared transport helper.
/// 3. Else, direct TCP.
async fn open_transport(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
    gw: Option<&GatewayOpt>,
) -> Result<RdpTransport, String> {
    if let Some(g) = gw {
        let stream = with_timeout(
            GATEWAY_CONNECT_TIMEOUT,
            "RD Gateway tunnel",
            gateway::open_tunnel(g, host, port),
        )
        .await?;
        return Ok(RdpTransport::new(
            stream,
            SocketAddr::from(([0, 0, 0, 0], 0)),
        ));
    }
    let proxy_kind = network.map(|n| n.proxy_kind.as_str()).unwrap_or("none");
    match proxy_kind {
        "" | "none" => {
            let s = with_timeout(
                DIRECT_CONNECT_TIMEOUT,
                "direct TCP connection",
                direct_tcp(host, port, network),
            )
            .await?;
            let local_addr = s
                .local_addr()
                .map_err(|e| format!("rdp: get local address: {}", e))?;
            Ok(RdpTransport::new(s, local_addr))
        }
        "http" | "socks5" | "system" => {
            let s = with_timeout(
                ROUTED_CONNECT_TIMEOUT,
                "proxy connection",
                establish_transport(host, port, network),
            )
            .await?;
            let local_addr = s
                .local_addr()
                .map_err(|e| format!("rdp: get local address: {}", e))?;
            Ok(RdpTransport::new(s, local_addr))
        }
        "ssh-tunnel" => {
            let s = with_timeout(
                GATEWAY_CONNECT_TIMEOUT,
                "SSH tunnel",
                build_ssh_transport(host, port, network),
            )
            .await?;
            Ok(RdpTransport::new(s, SocketAddr::from(([0, 0, 0, 0], 0))))
        }
        other => Err(format!(
            "Proxy type '{}' is not implemented for RDP (supported: none, http, socks5, ssh-tunnel, plus RD Gateway).",
            other,
        )),
    }
}

async fn with_timeout<T, E, F>(
    timeout: std::time::Duration,
    stage: &str,
    future: F,
) -> Result<T, String>
where
    E: Display,
    F: Future<Output = Result<T, E>>,
{
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| format!("RDP {stage} timed out after {} seconds", timeout.as_secs()))?
        .map_err(|error| error.to_string())
}

async fn direct_tcp(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
) -> Result<TcpStream, String> {
    // Reuse `establish_transport` for parity with SSH/VNC: same IP-version
    // policy and TCP_NODELAY default, and the function short-circuits to
    // direct TCP when proxy_kind == "none".
    let n = network.cloned();
    let mut effective = n.unwrap_or_default();
    effective.proxy_kind = "none".into();
    establish_transport(host, port, Some(&effective)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_unsupported_proxy_kind_for_rdp() {
        let mut net = NetworkSettings::default();
        net.proxy_kind = "unknown-proxy".into();
        net.proxy_host = "127.0.0.1".into();
        net.proxy_port = 1080;
        let res = open_transport("example.com", 3389, Some(&net), None).await;
        let err = match res {
            Ok(_) => panic!("should reject"),
            Err(e) => e,
        };
        assert!(err.contains("not implemented"));
    }

    #[tokio::test]
    async fn ssh_tunnel_uses_shared_ssh_transport() {
        let mut net = NetworkSettings::default();
        net.proxy_kind = "ssh-tunnel".into();
        net.jump_host = "127.0.0.1".into();
        net.jump_port = 22;
        net.jump_user = "ops".into();
        net.jump_auth_kind = "Password".into();

        let res = open_transport("rdp.internal", 3389, Some(&net), None).await;
        let err = match res {
            Ok(_) => panic!("empty jump password should fail in shared SSH transport"),
            Err(err) => err,
        };
        assert!(err.contains(crate::terminal::ssh::MISSING_JUMP_PASSWORD_ERROR));
    }

    #[tokio::test]
    async fn timeout_wrapper_reports_stage_and_duration() {
        let result = with_timeout(
            std::time::Duration::from_millis(5),
            "test stage",
            std::future::pending::<Result<(), &str>>(),
        )
        .await;
        let error = result.unwrap_err();
        assert!(error.contains("test stage"));
        assert!(error.contains("timed out"));
    }
}
