//! Loopback port forwarder for database connections.
//!
//! Database clients (`sqlx`, `redis-rs`, `reqwest`) connect by host:port and
//! give us no way to inject a custom transport stream the way russh's
//! `connect_stream` does. To route them through an HTTP/SOCKS5 proxy or an SSH
//! jump host, we bind a throwaway `127.0.0.1:0` listener, rewrite the client's
//! target to that local port, and bridge every accepted connection to the real
//! target through [`crate::terminal::ssh::build_ssh_transport`] — the same
//! proxy/jump machinery the SSH terminal uses.
//!
//! The listener task is owned by the `DbSession`; dropping/aborting it closes
//! the bound port and, via the per-connection `JoinSet`, every in-flight
//! bridge.

use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

use crate::terminal::network::NetworkSettings;
use crate::terminal::ssh::build_ssh_transport;

/// A running loopback forwarder: the local port clients should connect to,
/// plus the listener task handle for lifecycle teardown.
pub struct LoopbackForward {
    pub local_port: u16,
    pub task: JoinHandle<()>,
}

/// Start a loopback forwarder to `target_host:target_port` through `network`
/// (proxy or SSH jump host). Returns the local port to dial and the listener
/// task. Each accepted local connection opens its own transport to the target
/// and is bridged byte-for-byte until either side closes.
///
/// `network` must already have its proxy/jump secrets resolved (vault refs
/// turned into plaintext) by the caller.
pub async fn start(
    target_host: String,
    target_port: u16,
    network: NetworkSettings,
) -> Result<LoopbackForward, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("db forward: bind 127.0.0.1:0 failed: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("db forward: local_addr failed: {e}"))?
        .port();

    // Fail fast: probe the proxy/jump path once up front so connection errors
    // surface from `db_connect` instead of silently from a later accept. The
    // probe stream is dropped immediately; the per-connection bridges below
    // each open their own.
    let probe = build_ssh_transport(&target_host, target_port, Some(&network)).await?;
    drop(probe);

    let network = Arc::new(network);
    let task = tokio::spawn(async move {
        let mut bridges: JoinSet<()> = JoinSet::new();
        loop {
            while bridges.try_join_next().is_some() {}
            let (mut local, _peer) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("db forward accept failed: {e}");
                    continue;
                }
            };
            let host = target_host.clone();
            let net = network.clone();
            bridges.spawn(async move {
                match build_ssh_transport(&host, target_port, Some(&net)).await {
                    Ok(mut upstream) => {
                        if let Err(e) =
                            tokio::io::copy_bidirectional(&mut local, &mut upstream).await
                        {
                            tracing::debug!("db forward bridge ended: {e}");
                        }
                    }
                    Err(e) => {
                        tracing::warn!("db forward upstream connect failed: {e}");
                    }
                }
            });
        }
    });

    Ok(LoopbackForward { local_port, task })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// Loopback echo server. Returns its `(host, port)`.
    async fn spawn_echo() -> (String, u16) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    loop {
                        match s.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if s.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        ("127.0.0.1".to_string(), port)
    }

    /// No-auth SOCKS5 proxy bridging to the requested target. Returns its port.
    async fn spawn_socks5() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut head = [0u8; 2];
                    if c.read_exact(&mut head).await.is_err() {
                        return;
                    }
                    let mut methods = vec![0u8; head[1] as usize];
                    let _ = c.read_exact(&mut methods).await;
                    let _ = c.write_all(&[0x05, 0x00]).await;
                    let mut req = [0u8; 4];
                    if c.read_exact(&mut req).await.is_err() {
                        return;
                    }
                    let host = match req[3] {
                        0x01 => {
                            let mut a = [0u8; 4];
                            let _ = c.read_exact(&mut a).await;
                            std::net::Ipv4Addr::from(a).to_string()
                        }
                        0x03 => {
                            let mut l = [0u8; 1];
                            let _ = c.read_exact(&mut l).await;
                            let mut d = vec![0u8; l[0] as usize];
                            let _ = c.read_exact(&mut d).await;
                            String::from_utf8_lossy(&d).to_string()
                        }
                        _ => return,
                    };
                    let mut p = [0u8; 2];
                    let _ = c.read_exact(&mut p).await;
                    let dport = u16::from_be_bytes(p);
                    let _ = c
                        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                        .await;
                    if let Ok(mut up) = TcpStream::connect((host.as_str(), dport)).await {
                        let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
                    }
                });
            }
        });
        port
    }

    /// The DB loopback forwarder bridges a local connection through a real
    /// SOCKS5 proxy to the target — the same mechanism db_connect uses to
    /// route engine clients that can't take a custom transport stream.
    #[tokio::test]
    async fn loopback_forward_bridges_through_socks5_to_target() {
        let (echo_host, echo_port) = spawn_echo().await;
        let proxy_port = spawn_socks5().await;

        let mut net = NetworkSettings::default();
        net.proxy_kind = "socks5".into();
        net.proxy_host = "127.0.0.1".into();
        net.proxy_port = proxy_port;

        let fwd = start(echo_host, echo_port, net)
            .await
            .expect("start loopback forward");

        let mut client = TcpStream::connect(("127.0.0.1", fwd.local_port))
            .await
            .expect("dial loopback forward");
        client.write_all(b"hello").await.unwrap();
        let mut buf = [0u8; 5];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");

        fwd.task.abort();
    }
}
