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
