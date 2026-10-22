use super::limits::FLOW_WAIT;
use crate::sockscap::capture::linux::tracer::FlowQueue;
use crate::sockscap::relay::ACCEPT_BACKOFF_INITIAL;
use crate::sockscap::relay::ACCEPT_BACKOFF_MAX;
use crate::sockscap::relay::CapturedFlow;
use crate::sockscap::relay::MAX_ACTIVE_RELAY_FLOWS;
use crate::sockscap::relay::RELAY_PERMIT_WAIT;
use crate::sockscap::relay::RelayContext;
use crate::sockscap::relay::RelayHandle;
use crate::sockscap::relay::acquire_relay_flow_permit;
use crate::sockscap::relay::new_relay_flow_limiter;
use socket2::Domain;
use socket2::Protocol;
use socket2::Socket;
use socket2::Type;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;
use std::net::SocketAddrV6;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub(super) async fn start_redirect_ingress(
    ctx: Arc<RwLock<RelayContext>>,
    flows: Arc<FlowQueue>,
) -> Result<(RelayHandle, bool), String> {
    let listener_v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| format!("bind Linux launch redirect ingress: {error}"))?;
    let port = listener_v4
        .local_addr()
        .map_err(|error| format!("read Linux launch redirect ingress address: {error}"))?
        .port();
    let listener_v6 = match bind_loopback_v6(port) {
        Ok(listener) => Some(listener),
        Err(error) => {
            tracing::warn!("Linux launch-only IPv6 capture unavailable: {error}");
            None
        }
    };
    let ipv6_ready = listener_v6.is_some();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_task = Arc::clone(&stop);
    let limiter = new_relay_flow_limiter();
    let task = tokio::spawn(async move {
        let v4 = accept_loop(
            listener_v4,
            Arc::clone(&ctx),
            Arc::clone(&flows),
            Arc::clone(&stop_for_task),
            Arc::clone(&limiter),
        );
        if let Some(listener_v6) = listener_v6 {
            let v6 = accept_loop(listener_v6, ctx, flows, stop_for_task, limiter);
            let _ = tokio::join!(v4, v6);
        } else {
            v4.await;
        }
    });
    Ok((RelayHandle::new(port, stop, task), ipv6_ready))
}

pub(super) fn bind_loopback_v6(port: u16) -> Result<TcpListener, String> {
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))
        .map_err(|error| format!("create IPv6 launch ingress socket: {error}"))?;
    socket
        .set_only_v6(true)
        .map_err(|error| format!("set IPv6-only launch ingress socket: {error}"))?;
    socket
        .set_nonblocking(true)
        .map_err(|error| format!("set nonblocking launch ingress socket: {error}"))?;
    socket
        .bind(&SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, port, 0, 0)).into())
        .map_err(|error| format!("bind IPv6 launch ingress: {error}"))?;
    socket
        .listen(1024)
        .map_err(|error| format!("listen IPv6 launch ingress: {error}"))?;
    TcpListener::from_std(socket.into())
        .map_err(|error| format!("adopt IPv6 launch ingress: {error}"))
}

pub(super) async fn accept_loop(
    listener: TcpListener,
    ctx: Arc<RwLock<RelayContext>>,
    flows: Arc<FlowQueue>,
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
        let (socket, peer) = match listener.accept().await {
            Ok(connection) => {
                accept_backoff = ACCEPT_BACKOFF_INITIAL;
                connection
            }
            Err(error) => {
                if !stop.load(Ordering::SeqCst) {
                    tracing::warn!("Linux launch ingress accept failed: {error}");
                }
                tokio::time::sleep(accept_backoff).await;
                accept_backoff =
                    std::cmp::min(accept_backoff.saturating_mul(2), ACCEPT_BACKOFF_MAX);
                continue;
            }
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Some(permit) = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT).await
        else {
            if !stop.load(Ordering::SeqCst) {
                tracing::warn!(
                    "Linux launch ingress at capacity ({MAX_ACTIVE_RELAY_FLOWS}); refusing {peer}"
                );
            }
            continue;
        };
        let ctx = Arc::clone(&ctx);
        let flows = Arc::clone(&flows);
        clients.spawn(async move {
            let _permit = permit;
            match flows.wait_take(FLOW_WAIT).await {
                Some(flow) => {
                    let captured = CapturedFlow {
                        dest_ip: Some(flow.destination.ip()),
                        dest_host: None,
                        dest_port: flow.destination.port(),
                        process_path: Some(flow.process_path),
                        pid: Some(flow.pid),
                        origin: peer,
                        profile_id_hint: Some(flow.profile_id),
                    };
                    if let Err(error) =
                        crate::sockscap::relay::handle_captured_client(socket, captured, ctx).await
                    {
                        tracing::warn!("Linux rootless relay client {peer}: {error}");
                    }
                }
                None => tracing::warn!("Linux rootless relay client {peer}: no traced connect"),
            }
        });
    }
    clients.shutdown().await;
}
