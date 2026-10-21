use super::flow::process_path;
use super::flow::resolve_required_address;
use super::limits::DNS_UDP_IDLE_TIMEOUT;
use super::limits::UDP_DATAGRAM_BURST;
use super::limits::UDP_DATAGRAM_RATE_PER_SECOND;
use super::limits::UDP_IDLE_TIMEOUT;
use crate::sockscap::redirector::ipc::Address;
use crate::sockscap::redirector::ipc::UdpFlow;
use crate::sockscap::redirector::ipc::UdpPacket;
use crate::sockscap::redirector::ipc::read_optional_frame;
use crate::sockscap::redirector::ipc::write_frame;
use crate::sockscap::redirector::scope::ScopeSnapshot;
use crate::sockscap::relay::RelayContext;
use crate::sockscap::rules::dns::extract_ip_answers;
use std::net::IpAddr;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::UdpSocket;
use tokio::net::UnixStream;
use tokio::sync::RwLock;

pub(super) async fn serve_udp(
    mut ipc: UnixStream,
    flow: UdpFlow,
    scope: Arc<ScopeSnapshot>,
    block_quic: bool,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let process_path = process_path(flow.tunnel_info.as_ref());
    let pid = flow.tunnel_info.as_ref().and_then(|info| info.pid);
    let in_scope = scope.matches_process(process_path.as_deref());
    let Some(first) = read_optional_frame::<_, UdpPacket>(&mut ipc)
        .await
        .map_err(|error| format!("read first Redirector UDP packet: {error}"))?
    else {
        return Ok(());
    };
    let remote = resolve_required_address(first.remote_address.as_ref(), "UDP remote").await?;
    let (stats, dns_map) = {
        let context = ctx.read().await;
        (Arc::clone(&context.stats), Arc::clone(&context.dns_map))
    };
    if !in_scope {
        stats.record_scope_mismatch();
        tracing::warn!(
            ?pid,
            process = process_path.as_deref().unwrap_or("<unknown>"),
            %remote,
            "sockscap: Redirector delivered an out-of-scope UDP flow; failing open direct"
        );
    }
    if should_block_udp(in_scope, block_quic, remote) {
        stats.record_decision(false, true);
        stats.record_quic_drop();
        tracing::info!(
            ?pid,
            process = process_path.as_deref().unwrap_or("<unknown>"),
            %remote,
            "sockscap: blocked in-scope UDP/443 for QUIC fallback"
        );
        let _ = ipc.shutdown().await;
        return Ok(());
    }

    let bind_address = match remote.ip() {
        IpAddr::V4(_) => "0.0.0.0:0",
        IpAddr::V6(_) => "[::]:0",
    };
    let udp = UdpSocket::bind(bind_address)
        .await
        .map_err(|error| format!("bind UDP relay {bind_address}: {error}"))?;
    udp.send_to(&first.data, remote)
        .await
        .map_err(|error| format!("send UDP to {remote}: {error}"))?;
    stats.record_decision(false, false);
    stats.record_udp_direct_datagram();
    stats.add_bytes(first.data.len() as u64, 0);

    let (mut reader, mut writer) = ipc.into_split();
    let mut receive_buf = vec![0u8; 65_535];
    let mut rate_limiter = DatagramRateLimiter::new();
    // macOS commonly opens a fresh UDP socket for each DNS lookup. Keeping
    // those one-shot Redirector flows for a full minute amplifies startup DNS
    // bursts and needlessly consumes IPC/file-descriptor capacity.
    let idle_timeout = if remote.port() == 53 {
        DNS_UDP_IDLE_TIMEOUT
    } else {
        UDP_IDLE_TIMEOUT
    };
    let idle = tokio::time::sleep(idle_timeout);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            _ = &mut idle => {
                tracing::debug!(?pid, %remote, "sockscap: UDP direct flow expired after idle timeout");
                break;
            }
            packet = read_optional_frame::<_, UdpPacket>(&mut reader) => {
                let Some(packet) = packet.map_err(|error| format!("read Redirector UDP packet: {error}"))? else {
                    break;
                };
                idle.as_mut().reset(tokio::time::Instant::now() + idle_timeout);
                if !rate_limiter.allow() {
                    tracing::warn!(?pid, "sockscap: UDP source rate limit reached; dropping datagram");
                    continue;
                }
                let packet_remote = resolve_required_address(packet.remote_address.as_ref(), "UDP remote").await?;
                if should_block_udp(in_scope, block_quic, packet_remote) {
                    stats.record_quic_drop();
                    tracing::info!(?pid, %packet_remote, "sockscap: blocked in-scope UDP/443 for QUIC fallback");
                    let _ = writer.shutdown().await;
                    break;
                }
                udp.send_to(&packet.data, packet_remote)
                    .await
                    .map_err(|error| format!("relay UDP to {packet_remote}: {error}"))?;
                stats.record_udp_direct_datagram();
                stats.add_bytes(packet.data.len() as u64, 0);
            }
            received = udp.recv_from(&mut receive_buf) => {
                let (size, peer) = received.map_err(|error| format!("receive relayed UDP: {error}"))?;
                idle.as_mut().reset(tokio::time::Instant::now() + idle_timeout);
                if remote.port() == 53 || peer.port() == 53 {
                    let answers = extract_ip_answers(&receive_buf[..size]);
                    if !answers.is_empty()
                        && let Ok(mut map) = dns_map.lock()
                    {
                        for answer in &answers {
                            map.insert(answer.ip, answer.host.clone(), Some(answer.ttl));
                        }
                        stats.record_dns_answers(answers.len() as u64);
                    }
                }
                let response = UdpPacket {
                    data: bytes::Bytes::copy_from_slice(&receive_buf[..size]),
                    remote_address: Some(Address {
                        host: peer.ip().to_string(),
                        port: u32::from(peer.port()),
                    }),
                };
                write_frame(&mut writer, &response)
                    .await
                    .map_err(|error| format!("write Redirector UDP response: {error}"))?;
                stats.record_udp_direct_datagram();
                stats.add_bytes(0, size as u64);
            }
        }
    }
    Ok(())
}

pub(super) struct DatagramRateLimiter {
    pub(super) tokens: u64,
    pub(super) last_refill: std::time::Instant,
}

impl DatagramRateLimiter {
    pub(super) fn new() -> Self {
        Self {
            tokens: UDP_DATAGRAM_BURST,
            last_refill: std::time::Instant::now(),
        }
    }

    pub(super) fn allow(&mut self) -> bool {
        let elapsed = self.last_refill.elapsed();
        let refill = elapsed.as_secs_f64() * UDP_DATAGRAM_RATE_PER_SECOND as f64;
        if refill >= 1.0 {
            self.tokens = (self.tokens + refill as u64).min(UDP_DATAGRAM_BURST);
            self.last_refill = std::time::Instant::now();
        }
        if self.tokens == 0 {
            false
        } else {
            self.tokens -= 1;
            true
        }
    }
}

pub(super) fn should_block_udp(in_scope: bool, block_quic: bool, remote: SocketAddr) -> bool {
    in_scope && block_quic && remote.port() == 443
}
