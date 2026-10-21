use super::limits::CONNECT_TIMEOUT;
use super::limits::FLOW_HANDSHAKE_TIMEOUT;
use super::udp::serve_udp;
use crate::sockscap::redirector::ipc::Address;
use crate::sockscap::redirector::ipc::NewFlow;
use crate::sockscap::redirector::ipc::TcpFlow;
use crate::sockscap::redirector::ipc::TunnelInfo;
use crate::sockscap::redirector::ipc::new_flow;
use crate::sockscap::redirector::ipc::read_required_frame;
use crate::sockscap::redirector::scope::ScopeSnapshot;
use crate::sockscap::relay::CapturedFlow;
use crate::sockscap::relay::RelayContext;
use crate::sockscap::relay::handle_captured_stream;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::io::copy_bidirectional;
use tokio::net::TcpStream;
use tokio::net::UnixStream;
use tokio::net::lookup_host;
use tokio::sync::RwLock;

pub(super) async fn serve_flow(
    mut stream: UnixStream,
    scope: Arc<ScopeSnapshot>,
    block_quic: bool,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let flow = tokio::time::timeout(
        FLOW_HANDSHAKE_TIMEOUT,
        read_required_frame::<_, NewFlow>(&mut stream),
    )
    .await
    .map_err(|_| "Redirector flow handshake timed out".to_string())?
    .map_err(|error| format!("read Redirector NewFlow: {error}"))?;

    ctx.read().await.stats.record_flow_seen();
    match flow.message {
        Some(new_flow::Message::Tcp(flow)) => serve_tcp(stream, flow, scope, ctx).await,
        Some(new_flow::Message::Udp(flow)) => serve_udp(stream, flow, scope, block_quic, ctx).await,
        None => Err("Redirector NewFlow has no TCP/UDP payload".into()),
    }
}

pub(super) async fn serve_tcp(
    stream: UnixStream,
    flow: TcpFlow,
    scope: Arc<ScopeSnapshot>,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let remote = resolve_required_address(flow.remote_address.as_ref(), "TCP remote").await?;
    let process_path = process_path(flow.tunnel_info.as_ref());
    let pid = flow.tunnel_info.as_ref().and_then(|info| info.pid);

    if !scope.matches_process(process_path.as_deref()) {
        tracing::warn!(
            ?pid,
            process = process_path.as_deref().unwrap_or("<unknown>"),
            %remote,
            "sockscap: Redirector delivered an out-of-scope TCP flow; failing open direct"
        );
        let stats = Arc::clone(&ctx.read().await.stats);
        stats.record_scope_mismatch();
        stats.record_decision(false, false);
        return relay_tcp_direct(stream, remote, stats).await;
    }

    let flow = CapturedFlow {
        dest_ip: Some(remote.ip()),
        dest_host: None,
        dest_port: remote.port(),
        process_path: process_path.clone(),
        pid,
        origin: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        profile_id_hint: scope
            .profile_id_hint(process_path.as_deref())
            .map(str::to_owned),
    };
    handle_captured_stream(stream, flow, ctx).await
}

pub(super) async fn relay_tcp_direct(
    mut stream: UnixStream,
    remote: SocketAddr,
    stats: Arc<crate::sockscap::stats::StatsCounters>,
) -> Result<(), String> {
    let mut upstream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(remote))
        .await
        .map_err(|_| format!("direct TCP {remote} timed out"))?
        .map_err(|error| format!("direct TCP {remote}: {error}"))?;
    let (up, down) = copy_bidirectional(&mut stream, &mut upstream)
        .await
        .map_err(|error| format!("direct TCP bridge {remote}: {error}"))?;
    stats.add_bytes(up, down);
    Ok(())
}

pub(super) fn process_path(info: Option<&TunnelInfo>) -> Option<String> {
    info.and_then(|info| {
        info.process_name
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
    })
}

pub(super) async fn resolve_required_address(
    address: Option<&Address>,
    label: &str,
) -> Result<SocketAddr, String> {
    let address = address.ok_or_else(|| format!("Redirector {label} address is missing"))?;
    let port = u16::try_from(address.port)
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| format!("Redirector {label} port is invalid: {}", address.port))?;
    if address.host.trim().is_empty() {
        return Err(format!("Redirector {label} host is empty"));
    }
    if let Ok(ip) = address.host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    lookup_host((address.host.as_str(), port))
        .await
        .map_err(|error| {
            format!(
                "resolve Redirector {label} {}:{port}: {error}",
                address.host
            )
        })?
        .next()
        .ok_or_else(|| format!("Redirector {label} resolved no addresses"))
}
