//! Local loopback relay: accept NAT'd connections from WinDivert helper,
//! apply policy, dial DIRECT / HTTP / SOCKS5, bridge bytes.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

use crate::sockscap::config::{Decision, SocksCapConfig, UpstreamKind};
use crate::sockscap::egress;
use crate::sockscap::helper::{self, HelperRegistry};
use crate::sockscap::policy::{PolicyEngine, PolicyInput};
use crate::sockscap::rules::CompiledRules;
use crate::sockscap::stats::StatsCounters;

pub struct RelayHandle {
    pub port: u16,
    stop: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl RelayHandle {
    pub async fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // Connect once to unblock accept if needed.
        let _ = TcpStream::connect(("127.0.0.1", self.port)).await;
        let _ = self.task.await;
    }
}

pub struct RelayContext {
    pub config: SocksCapConfig,
    pub rules: Option<CompiledRules>,
    pub helper: Arc<HelperRegistry>,
    pub stats: Arc<StatsCounters>,
    /// Resolved upstream (host/port/user/pass) for PROXY decisions.
    pub upstream_host: String,
    pub upstream_port: u16,
    pub upstream_user: String,
    pub upstream_pass: String,
    pub self_pid: u32,
}

/// Bind 127.0.0.1:0 and serve redirected flows.
pub async fn start_relay(ctx: Arc<RwLock<RelayContext>>) -> Result<RelayHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("relay bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = Arc::clone(&stop);
    let task = tokio::spawn(async move {
        loop {
            if stop2.load(Ordering::SeqCst) {
                break;
            }
            let (sock, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => {
                    if stop2.load(Ordering::SeqCst) {
                        break;
                    }
                    continue;
                }
            };
            if stop2.load(Ordering::SeqCst) {
                break;
            }
            let ctx = Arc::clone(&ctx);
            tokio::spawn(async move {
                if let Err(e) = handle_client(sock, peer, ctx).await {
                    tracing::debug!("sockscap relay client: {e}");
                }
            });
        }
    });
    Ok(RelayHandle { port, stop, task })
}

async fn handle_client(
    mut client: TcpStream,
    peer: SocketAddr,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let peer_port = peer.port();
    let snap = {
        let g = ctx.read().await;
        // Lookup original destination via helper.
        let mapping = {
            let guard = g.helper.inner.lock().map_err(|e| e.to_string())?;
            let sess = guard
                .as_ref()
                .ok_or_else(|| "helper session missing".to_string())?;
            helper::lookup_orig(sess, peer_port)?
        };

        let dst_ip: IpAddr = mapping
            .dst_ip
            .parse()
            .map_err(|e| format!("bad dst ip: {e}"))?;
        let engine = PolicyEngine::from_config(&g.config, g.rules.as_ref());
        let input = PolicyInput {
            host: None,
            ip: Some(dst_ip),
            port: mapping.dst_port,
            process_path: if mapping.path.is_empty() {
                None
            } else {
                Some(mapping.path.clone())
            },
            pid: Some(mapping.pid),
        };
        let trace = engine.decide(&input);
        (
            mapping,
            trace,
            g.config.upstream.kind,
            g.upstream_host.clone(),
            g.upstream_port,
            g.upstream_user.clone(),
            g.upstream_pass.clone(),
            Arc::clone(&g.stats),
        )
    };

    let (mapping, trace, kind, up_host, up_port, up_user, up_pass, stats) = snap;
    let dest_host = mapping.dst_ip;
    let dest_port = mapping.dst_port;

    match trace.decision {
        Decision::Block => {
            stats.record_decision(false, true);
            return Err(format!("blocked {dest_host}:{dest_port} ({})", trace.reason));
        }
        Decision::Direct => {
            stats.record_decision(false, false);
            let mut remote = TcpStream::connect((dest_host.as_str(), dest_port))
                .await
                .map_err(|e| format!("direct connect {dest_host}:{dest_port}: {e}"))?;
            bridge(&mut client, &mut remote).await?;
        }
        Decision::Proxy => {
            stats.record_decision(true, false);
            let mut remote = match kind {
                UpstreamKind::Http => {
                    egress::http_connect::dial(
                        &up_host,
                        up_port,
                        &dest_host,
                        dest_port,
                        &up_user,
                        &up_pass,
                    )
                    .await?
                }
                UpstreamKind::Socks5 => {
                    egress::socks5::dial(
                        &up_host,
                        up_port,
                        &dest_host,
                        dest_port,
                        &up_user,
                        &up_pass,
                    )
                    .await?
                }
                UpstreamKind::Ssh => {
                    return Err("SSH upstream not wired in capture path yet".into());
                }
            };
            bridge(&mut client, &mut remote).await?;
        }
    }
    Ok(())
}

async fn bridge(a: &mut TcpStream, b: &mut TcpStream) -> Result<(), String> {
    // split and copy both directions
    let (mut ar, mut aw) = a.split();
    let (mut br, mut bw) = b.split();
    let ab = async {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = ar.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            bw.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        }
        let _ = bw.shutdown().await;
        Ok::<(), String>(())
    };
    let ba = async {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = br.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            aw.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        }
        let _ = aw.shutdown().await;
        Ok::<(), String>(())
    };
    tokio::select! {
        r = ab => r?,
        r = ba => r?,
    }
    Ok(())
}

/// Resolve manual upstream fields from config (session resolution is a follow-up).
pub fn upstream_from_config(cfg: &SocksCapConfig) -> (String, u16, String, String) {
    (
        cfg.upstream.host.clone(),
        cfg.upstream.port,
        cfg.upstream.username.clone(),
        String::new(), // password resolved later via vault
    )
}

pub fn relay_loopback_ip() -> Ipv4Addr {
    Ipv4Addr::new(127, 0, 0, 1)
}
