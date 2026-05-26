//! Transport selection for an RDP session.
//!
//! Three modes converge on the same `Box<dyn AsyncRead + AsyncWrite + Unpin + Send>`:
//!
//! - **Direct TCP** — same DNS / IP-version logic as SSH and VNC.
//! - **HTTP CONNECT or SOCKS5 proxy** — delegated to
//!   [`crate::terminal::network::establish_transport`], which already
//!   speaks both with auth.
//! - **RD Gateway (MS-TSGU)** — a hand-rolled RPC-over-HTTPS twin-channel
//!   wrapper in [`super::gateway`] that exposes its tunnelled stream as
//!   `AsyncRead + AsyncWrite`.
//!
//! Higher layers (X.224 negotiation, TLS upgrade, MCS, …) treat the
//! transport opaquely.

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::rdp::gateway::{self, GatewayOpt};
use crate::terminal::network::{establish_transport, NetworkSettings};

/// Boxed object-safe transport.
pub type BoxedStream = Box<dyn AsyncReadWrite>;

/// A trait-object marker combining `AsyncRead + AsyncWrite + Unpin + Send`
/// so we can return one out of `open_transport` regardless of which path
/// we took. We can't directly `Box<dyn AsyncRead + AsyncWrite + …>` because
/// only one auto-trait can be combined into a trait object.
pub trait AsyncReadWrite: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + ?Sized> AsyncReadWrite for T {}

/// Open an RDP transport.
///
/// Selection rules:
///
/// 1. If `gateway` is `Some`, route through the RD Gateway. The host/port
///    arguments are the *target* RDP server inside the gateway tunnel.
/// 2. Else, if `network` indicates a non-`none` proxy (`http` / `socks5`),
///    route through that proxy via the existing SSH transport helper.
/// 3. Else, direct TCP.
pub async fn open_transport(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
    gw: Option<&GatewayOpt>,
) -> Result<BoxedStream, String> {
    if let Some(g) = gw {
        let stream = gateway::open_tunnel(g, host, port).await?;
        return Ok(Box::new(stream));
    }
    let proxy_kind = network.map(|n| n.proxy_kind.as_str()).unwrap_or("none");
    match proxy_kind {
        "" | "none" => {
            let s = direct_tcp(host, port, network).await?;
            Ok(Box::new(s))
        }
        "http" | "socks5" => {
            let s = establish_transport(host, port, network).await?;
            Ok(Box::new(s))
        }
        other => Err(format!(
            "Proxy type '{}' is not implemented for RDP (supported: none, http, socks5, plus RD Gateway).",
            other,
        )),
    }
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
        net.proxy_kind = "socks4".into();
        net.proxy_host = "127.0.0.1".into();
        net.proxy_port = 1080;
        let res = open_transport("example.com", 3389, Some(&net), None).await;
        let err = match res {
            Ok(_) => panic!("should reject"),
            Err(e) => e,
        };
        assert!(err.contains("not implemented"));
    }
}
