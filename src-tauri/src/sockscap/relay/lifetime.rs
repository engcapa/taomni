use super::admission::acquire_relay_flow_permit;
use super::admission::enable_keepalive;
use super::admission::new_relay_flow_limiter;
use super::context::CapturedFlow;
use super::context::RelayContext;
use super::flow::handle_captured_stream;
use super::limits::ACCEPT_BACKOFF_INITIAL;
use super::limits::ACCEPT_BACKOFF_MAX;
use super::limits::MAX_ACTIVE_RELAY_FLOWS;
use super::limits::RELAY_PERMIT_WAIT;
use std::net::IpAddr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::RwLock;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio::task::JoinSet;

pub struct RelayHandle {
    pub port: u16,
    pub(super) stop: Arc<AtomicBool>,
    pub(super) task: JoinHandle<()>,
}

impl RelayHandle {
    pub(crate) fn new(port: u16, stop: Arc<AtomicBool>, task: JoinHandle<()>) -> Self {
        Self { port, stop, task }
    }

    /// Stop accept loops promptly.
    ///
    /// Must wake **both** IPv4 and IPv6 listeners (we bind 0.0.0.0 and optionally ::).
    /// A previous bug only connected to 127.0.0.1, leaving the IPv6 accept task
    /// blocked forever so `Stop` never returned.
    pub async fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        let port = self.port;
        // Best-effort wake of both stacks (ignore connect errors).
        let wake_v4 = TcpStream::connect(("127.0.0.1", port));
        let wake_v6 = TcpStream::connect((Ipv6Addr::LOCALHOST, port));
        let _ = tokio::join!(wake_v4, wake_v6);

        let mut task = self.task;
        tokio::select! {
            _ = &mut task => {}
            _ = tokio::time::sleep(Duration::from_millis(800)) => {
                tracing::warn!(
                    "sockscap relay accept loops did not exit within 800ms; aborting task"
                );
                task.abort();
                let _ = task.await;
            }
        }
    }
}

/// Bind **0.0.0.0:0** (all interfaces) — required for WinDivert streamdump-style
/// reflection, which delivers connections as `remote → client_lan_ip:relay`
/// rather than to 127.0.0.1. Unknown peers without a redirect mapping are dropped.
/// IPv6: also listen on `[::]:port` when available.
pub async fn start_relay(ctx: Arc<RwLock<RelayContext>>) -> Result<RelayHandle, String> {
    let listener = TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|e| format!("relay bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // Best-effort dual-stack IPv6 any.
    let listener_v6 = TcpListener::bind((std::net::Ipv6Addr::UNSPECIFIED, port))
        .await
        .ok();

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = Arc::clone(&stop);
    let limiter = new_relay_flow_limiter();
    let task = tokio::spawn(async move {
        let stop_v4 = Arc::clone(&stop2);
        let ctx_v4 = Arc::clone(&ctx);
        let limiter_v4 = Arc::clone(&limiter);
        let v4 = accept_loop(listener, ctx_v4, stop_v4, limiter_v4);

        if let Some(l6) = listener_v6 {
            let stop_v6 = Arc::clone(&stop2);
            let ctx_v6 = Arc::clone(&ctx);
            let limiter_v6 = Arc::clone(&limiter);
            let v6 = accept_loop(l6, ctx_v6, stop_v6, limiter_v6);
            let _ = tokio::join!(v4, v6);
        } else {
            v4.await;
        }
    });
    Ok(RelayHandle::new(port, stop, task))
}

pub(super) async fn accept_loop(
    listener: TcpListener,
    ctx: Arc<RwLock<RelayContext>>,
    stop: Arc<AtomicBool>,
    limiter: Arc<Semaphore>,
) {
    let mut clients = JoinSet::new();
    let mut accept_backoff = ACCEPT_BACKOFF_INITIAL;
    loop {
        while clients.try_join_next().is_some() {}
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let (sock, peer) = match listener.accept().await {
            Ok(v) => {
                accept_backoff = ACCEPT_BACKOFF_INITIAL;
                v
            }
            Err(error) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                tracing::warn!(
                    "sockscap relay accept failed: {error}; retrying in {}ms",
                    accept_backoff.as_millis()
                );
                tokio::time::sleep(accept_backoff).await;
                accept_backoff =
                    std::cmp::min(accept_backoff.saturating_mul(2), ACCEPT_BACKOFF_MAX);
                continue;
            }
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }

        // Capacity is claimed *after* accepting, and never blocks the loop
        // indefinitely. Waiting for a permit before `accept` left the listener
        // un-drained: connections piled into the kernel backlog and, once it
        // filled, further SYNs were dropped. Because the client's SYN had
        // already been reflected toward the relay, the application saw an
        // indefinite hang rather than a refusal — the whole machine looked
        // wedged. Refusing promptly instead gives the app an error it can retry.
        let Some(permit) = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT).await
        else {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            tracing::warn!(
                "sockscap relay at capacity ({MAX_ACTIVE_RELAY_FLOWS} concurrent flows); \
                 refusing {peer} after waiting {}s",
                RELAY_PERMIT_WAIT.as_secs()
            );
            drop(sock);
            continue;
        };
        let ctx = Arc::clone(&ctx);
        clients.spawn(async move {
            let _permit = permit;
            if let Err(e) = handle_client(sock, peer, ctx).await {
                // Mapping miss / upstream fail are the usual "proxy does nothing" causes.
                tracing::warn!("sockscap relay client {peer}: {e}");
            }
        });
    }
    clients.shutdown().await;
}

pub(super) async fn handle_client(
    client: TcpStream,
    peer: SocketAddr,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let peer_port = peer.port();
    let peer_ip = peer.ip().to_string();

    // Take a handle and release the context lock immediately. This lookup is a
    // round trip to another process; the previous code held both this read lock
    // and the helper registry's mutex across it, so every captured connection
    // queued behind every other one.
    let rpc = { ctx.read().await.helper_client.clone() };
    let rpc = rpc.ok_or_else(|| "helper control channel missing".to_string())?;

    // Streamdump peer is orig_remote:client_sport — prefer exact ip:port key.
    let mapping = match rpc.lookup_orig(&peer_ip, peer_port).await {
        Ok(m) => m,
        Err(_) => rpc.lookup_orig("", peer_port).await?,
    };
    let dst_ip: IpAddr = mapping
        .dst_ip
        .parse()
        .map_err(|e| format!("bad dst ip: {e}"))?;
    let flow = CapturedFlow {
        process_path: (!mapping.path.is_empty()).then_some(mapping.path),
        pid: (mapping.pid != 0).then_some(mapping.pid),
        ..CapturedFlow::from_destination(SocketAddr::new(dst_ip, mapping.dst_port), peer)
    };
    handle_captured_client(client, flow, ctx).await
}

/// Apply shared hostname/policy/egress processing to a flow whose original
/// destination was recovered by a platform capture backend.
pub(crate) async fn handle_captured_client(
    client: TcpStream,
    flow: CapturedFlow,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    // The captured side is a real TCP socket on the Windows/Linux backends;
    // keep it probed so a vanished client releases its flow slot. macOS's
    // Redirector supplies a UnixStream and enters through
    // `handle_captured_stream`, where TCP keepalive is not applicable.
    enable_keepalive(&client);
    handle_captured_stream(client, flow, ctx).await
}
