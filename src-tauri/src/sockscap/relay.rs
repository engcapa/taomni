//! Local loopback relay: accept NAT'd connections from WinDivert helper,
//! attribute hostname (SNI / HTTP Host), apply policy, dial egress, bridge.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

use crate::sockscap::config::{Decision, SocksCapConfig, UpstreamKind};
use crate::sockscap::egress;
use crate::sockscap::egress::ssh_pool::SshPool;
use crate::sockscap::helper::{self, HelperRegistry};
use crate::sockscap::policy::{PolicyEngine, PolicyInput};
use crate::sockscap::rules::dns_map::DnsMap;
use crate::sockscap::rules::sni::extract_hostname_from_prefix;
use crate::sockscap::rules::CompiledRules;
use crate::sockscap::stats::StatsCounters;

pub struct RelayHandle {
    pub port: u16,
    stop: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl RelayHandle {
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

pub struct RelayContext {
    pub config: SocksCapConfig,
    pub rules: Option<CompiledRules>,
    pub helper: Arc<HelperRegistry>,
    pub stats: Arc<StatsCounters>,
    pub upstream_host: String,
    pub upstream_port: u16,
    pub upstream_user: String,
    pub upstream_pass: String,
    pub self_pid: u32,
    /// Shared SSH session when upstream kind is SSH.
    pub ssh_pool: Option<Arc<SshPool>>,
    /// IP → hostname learned from SNI / HTTP Host.
    pub dns_map: Arc<Mutex<DnsMap>>,
    /// Domain & flow traffic tracker
    pub domains: Arc<Mutex<crate::sockscap::stats::DomainTracker>>,
}

/// Bind **0.0.0.0:0** (all interfaces) — required for WinDivert streamdump-style
/// reflection, which delivers connections as `remote → client_lan_ip:relay`
/// rather than to 127.0.0.1. Unknown peers without a redirect mapping are dropped.
/// IPv6: also listen on `[::]:port` when available.
pub async fn start_relay(ctx: Arc<RwLock<RelayContext>>) -> Result<RelayHandle, String> {
    let listener = TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|e| format!("relay bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    // Best-effort dual-stack IPv6 any.
    let listener_v6 = TcpListener::bind((std::net::Ipv6Addr::UNSPECIFIED, port))
        .await
        .ok();

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = Arc::clone(&stop);
    let task = tokio::spawn(async move {
        let stop_v4 = Arc::clone(&stop2);
        let ctx_v4 = Arc::clone(&ctx);
        let v4 = tokio::spawn(async move {
            accept_loop(listener, ctx_v4, stop_v4).await;
        });

        if let Some(l6) = listener_v6 {
            let stop_v6 = Arc::clone(&stop2);
            let ctx_v6 = Arc::clone(&ctx);
            let v6 = tokio::spawn(async move {
                accept_loop(l6, ctx_v6, stop_v6).await;
            });
            let _ = tokio::join!(v4, v6);
        } else {
            let _ = v4.await;
        }
    });
    Ok(RelayHandle { port, stop, task })
}

async fn accept_loop(
    listener: TcpListener,
    ctx: Arc<RwLock<RelayContext>>,
    stop: Arc<AtomicBool>,
) {
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let (sock, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(_) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                continue;
            }
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let ctx = Arc::clone(&ctx);
        tokio::spawn(async move {
            if let Err(e) = handle_client(sock, peer, ctx).await {
                // Mapping miss / upstream fail are the usual "proxy does nothing" causes.
                tracing::warn!("sockscap relay client {peer}: {e}");
            }
        });
    }
}

async fn handle_client(
    mut client: TcpStream,
    peer: SocketAddr,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let peer_port = peer.port();
    let peer_ip = peer.ip().to_string();

    // Multi-read peek for SNI / HTTP Host (ClientHello may span packets).
    let (prefix, hostname) = peek_for_hostname(&mut client).await;

    let snap = {
        let g = ctx.read().await;
        let mapping = {
            let guard = g.helper.inner.lock().map_err(|e| e.to_string())?;
            let sess = guard
                .as_ref()
                .ok_or_else(|| "helper session missing".to_string())?;
            // Streamdump peer is orig_remote:client_sport — prefer exact ip:port key.
            helper::lookup_orig_key(sess, &peer_ip, peer_port)
                .or_else(|_| helper::lookup_orig(sess, peer_port))?
        };

        let dst_ip: IpAddr = mapping
            .dst_ip
            .parse()
            .map_err(|e| format!("bad dst ip: {e}"))?;

        // Learn IP→host from this flow for later pure-IP connections.
        if let Some(host) = hostname.as_ref() {
            if let Ok(ip) = mapping.dst_ip.parse::<IpAddr>() {
                if let Ok(mut map) = g.dns_map.lock() {
                    map.insert(ip, host.clone(), None);
                }
            }
        }

        // Prefer live SNI/Host, then dns_map, then none.
        let host_for_policy = hostname.clone().or_else(|| {
            g.dns_map
                .lock()
                .ok()
                .and_then(|mut m| m.lookup(dst_ip))
        });

        let engine = PolicyEngine::from_config(&g.config, g.rules.as_ref());
        let input = PolicyInput {
            host: host_for_policy,
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
            hostname,
            trace,
            g.config.upstream.kind,
            g.upstream_host.clone(),
            g.upstream_port,
            g.upstream_user.clone(),
            g.upstream_pass.clone(),
            Arc::clone(&g.stats),
            g.ssh_pool.clone(),
            Arc::clone(&g.domains),
        )
    };

    let (
        mapping,
        hostname,
        trace,
        kind,
        up_host,
        up_port,
        up_user,
        up_pass,
        stats,
        ssh_pool,
        domains,
    ) = snap;

    // Prefer hostname for dial when known (proxy-side DNS).
    let dial_host = hostname
        .clone()
        .unwrap_or_else(|| mapping.dst_ip.clone());
    let dest_port = mapping.dst_port;

    let res = match trace.decision {
        Decision::Block => {
            stats.record_decision(false, true);
            if let Ok(mut doms) = domains.lock() {
                doms.record(
                    dial_host.clone(),
                    trace.decision,
                    trace.matched_rule.clone(),
                    if mapping.path.is_empty() { None } else { Some(mapping.path.clone()) },
                    Some(mapping.pid),
                    0,
                    0,
                );
            }
            return Err(format!(
                "blocked {dial_host}:{dest_port} ({})",
                trace.reason
            ));
        }
        Decision::Direct => {
            stats.record_decision(false, false);
            let mut remote = TcpStream::connect((dial_host.as_str(), dest_port))
                .await
                .map_err(|e| format!("direct connect {dial_host}:{dest_port}: {e}"))?;
            if !prefix.is_empty() {
                remote
                    .write_all(&prefix)
                    .await
                    .map_err(|e| format!("prefix write: {e}"))?;
            }
            bridge_tcp(&mut client, &mut remote).await
        }
        Decision::Proxy => {
            stats.record_decision(true, false);
            match kind {
                UpstreamKind::Http => {
                    let mut remote = egress::http_connect::dial(
                        &up_host,
                        up_port,
                        &dial_host,
                        dest_port,
                        &up_user,
                        &up_pass,
                    )
                    .await?;
                    if !prefix.is_empty() {
                        remote
                            .write_all(&prefix)
                            .await
                            .map_err(|e| format!("prefix write: {e}"))?;
                    }
                    bridge_tcp(&mut client, &mut remote).await
                }
                UpstreamKind::Socks5 => {
                    let mut remote = egress::socks5::dial(
                        &up_host,
                        up_port,
                        &dial_host,
                        dest_port,
                        &up_user,
                        &up_pass,
                    )
                    .await?;
                    if !prefix.is_empty() {
                        remote
                            .write_all(&prefix)
                            .await
                            .map_err(|e| format!("prefix write: {e}"))?;
                    }
                    bridge_tcp(&mut client, &mut remote).await
                }
                UpstreamKind::Ssh => {
                    let pool = ssh_pool.ok_or_else(|| "SSH pool not initialized".to_string())?;
                    let origin = peer.ip().to_string();
                    let mut remote = pool
                        .dial(&dial_host, dest_port, &origin, peer.port())
                        .await?;
                    if !prefix.is_empty() {
                        remote
                            .write_all(&prefix)
                            .await
                            .map_err(|e| format!("prefix write: {e}"))?;
                    }
                    bridge_any(&mut client, &mut remote).await
                }
            }
        }
    };

    match res {
        Ok((bytes_a, bytes_b)) => {
            let up = bytes_a + prefix.len() as u64;
            let down = bytes_b;
            stats.add_bytes(up, down);
            if let Ok(mut doms) = domains.lock() {
                doms.record(
                    dial_host,
                    trace.decision,
                    trace.matched_rule,
                    if mapping.path.is_empty() { None } else { Some(mapping.path) },
                    Some(mapping.pid),
                    up,
                    down,
                );
            }
        }
        Err(e) => return Err(e),
    }

    Ok(())
}

/// Read until we extract a hostname, TLS record is complete, or budget exhausted.
async fn peek_for_hostname(client: &mut TcpStream) -> (Vec<u8>, Option<String>) {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(900);
    let mut prefix: Vec<u8> = Vec::new();
    while Instant::now() < deadline && prefix.len() < 16 * 1024 {
        if let Some(h) = extract_hostname_from_prefix(&prefix) {
            return (prefix, Some(h));
        }
        // TLS: wait for full record if we can see the length.
        if prefix.len() >= 5 && prefix[0] == 0x16 {
            let rec_len = u16::from_be_bytes([prefix[3], prefix[4]]) as usize;
            if prefix.len() >= 5 + rec_len {
                break;
            }
        } else if prefix.len() >= 32 {
            // Not TLS and no Host yet — stop waiting.
            if extract_hostname_from_prefix(&prefix).is_none()
                && !looks_like_incomplete_http(&prefix)
            {
                break;
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut buf = vec![0u8; 2048];
        match tokio::time::timeout(remaining, client.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => prefix.extend_from_slice(&buf[..n]),
            _ => break,
        }
    }
    let host = extract_hostname_from_prefix(&prefix);
    (prefix, host)
}

fn looks_like_incomplete_http(data: &[u8]) -> bool {
    if data.is_empty() || data[0] == 0x16 {
        return false;
    }
    let Ok(s) = std::str::from_utf8(data) else {
        return false;
    };
    let upper = s.to_ascii_uppercase();
    (upper.starts_with("GET ")
        || upper.starts_with("POST ")
        || upper.starts_with("HEAD ")
        || upper.starts_with("CONNECT "))
        && !s.contains("\r\n\r\n")
}

async fn bridge_tcp(a: &mut TcpStream, b: &mut TcpStream) -> Result<(u64, u64), String> {
    bridge_any(a, b).await
}

async fn bridge_any<A, B>(a: &mut A, b: &mut B) -> Result<(u64, u64), String>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    tokio::io::copy_bidirectional(a, b)
        .await
        .map_err(|e| format!("bridge: {e}"))
}

/// Resolve manual upstream fields from config.
pub fn upstream_from_config(cfg: &SocksCapConfig) -> (String, u16, String, String) {
    (
        cfg.upstream.host.clone(),
        cfg.upstream.port,
        cfg.upstream.username.clone(),
        String::new(),
    )
}

pub fn relay_loopback_ip() -> Ipv4Addr {
    Ipv4Addr::new(127, 0, 0, 1)
}
