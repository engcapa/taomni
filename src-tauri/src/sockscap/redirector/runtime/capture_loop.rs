use super::bridge::BridgeSession;
use super::bridge::SocketCleanup;
use super::bridge::read_bridge_event;
use super::bridge::stop_bridge;
use super::bridge::write_bridge_command;
use super::flow::serve_flow;
use super::limits::FILE_DESCRIPTORS_PER_FLOW;
use super::limits::HEARTBEAT_INTERVAL;
use super::limits::MAX_PENDING_HEARTBEATS;
use super::limits::MIN_RELAY_FLOW_CAPACITY;
use super::limits::RESERVED_FILE_DESCRIPTORS;
use super::limits::TARGET_NOFILE_LIMIT;
use super::telemetry::RuntimeTelemetry;
use crate::sockscap::redirector::bridge_protocol::BRIDGE_PROTOCOL_VERSION;
use crate::sockscap::redirector::bridge_protocol::BridgeCommand;
use crate::sockscap::redirector::bridge_protocol::BridgeEvent;
use crate::sockscap::redirector::redirector_peer_pid;
use crate::sockscap::redirector::scope::ScopeSnapshot;
use crate::sockscap::relay::MAX_ACTIVE_RELAY_FLOWS;
use crate::sockscap::relay::RelayContext;
use std::collections::BTreeSet;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixListener;
use tokio::net::UnixStream;
use tokio::sync::RwLock;
use tokio::sync::oneshot;
use tokio::task::JoinSet;

/// Raise launchd's conservative per-process soft limit before global capture.
/// A macOS GUI app commonly starts at 256 descriptors, while every active flow
/// needs one Redirector IPC socket and one egress socket in addition to the
/// desktop app's normal files, terminals, and database handles.
pub(super) fn prepare_file_descriptor_budget() -> Result<u64, String> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(format!(
            "read macOS file descriptor limit: {}",
            std::io::Error::last_os_error()
        ));
    }
    let desired = TARGET_NOFILE_LIMIT.min(limit.rlim_max);
    if limit.rlim_cur < desired {
        let raised = libc::rlimit {
            rlim_cur: desired,
            rlim_max: limit.rlim_max,
        };
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } != 0 {
            return Err(format!(
                "raise macOS file descriptor limit from {} to {desired}: {}",
                limit.rlim_cur,
                std::io::Error::last_os_error()
            ));
        }
        limit.rlim_cur = desired;
    }
    Ok(limit.rlim_cur)
}

pub(super) fn relay_flow_capacity(file_descriptor_limit: u64) -> usize {
    let descriptor_capacity =
        file_descriptor_limit.saturating_sub(RESERVED_FILE_DESCRIPTORS) / FILE_DESCRIPTORS_PER_FLOW;
    usize::try_from(descriptor_capacity)
        .unwrap_or(MAX_ACTIVE_RELAY_FLOWS)
        .clamp(MIN_RELAY_FLOW_CAPACITY, MAX_ACTIVE_RELAY_FLOWS)
}

pub(super) async fn run_capture(
    listener: UnixListener,
    mut bridge: BridgeSession,
    scope: Arc<ScopeSnapshot>,
    block_quic: bool,
    flow_capacity: usize,
    ctx: Arc<RwLock<RelayContext>>,
    mut stop_rx: oneshot::Receiver<()>,
    _cleanup: SocketCleanup,
    telemetry: Arc<RuntimeTelemetry>,
) -> Result<(), String> {
    let mut flows = JoinSet::new();
    let limiter = Arc::new(tokio::sync::Semaphore::new(flow_capacity));
    let stats = Arc::clone(&ctx.read().await.stats);
    let mut accept_error = None;
    let mut pending_heartbeats = BTreeSet::new();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        while let Some(result) = flows.try_join_next() {
            if let Err(error) = result {
                tracing::warn!("sockscap: Redirector flow task failed: {error}");
            }
        }
        tokio::select! {
            _ = &mut stop_rx => break,
            _ = heartbeat.tick() => {
                if pending_heartbeats.len() >= MAX_PENDING_HEARTBEATS {
                    accept_error = Some(format!(
                        "Redirector bridge missed {} consecutive heartbeat responses",
                        pending_heartbeats.len()
                    ));
                    break;
                }
                let request_id = bridge.next_request_id;
                bridge.next_request_id = bridge.next_request_id.saturating_add(1);
                if let Err(error) = write_bridge_command(
                    &mut bridge.input,
                    &BridgeCommand::Ping {
                        version: BRIDGE_PROTOCOL_VERSION,
                        request_id,
                        session_id: bridge.session_id.clone(),
                        generation: bridge.generation,
                    },
                )
                .await
                {
                    accept_error = Some(format!("Redirector bridge heartbeat failed: {error}"));
                    break;
                }
                pending_heartbeats.insert(request_id);
            }
            event = read_bridge_event(&mut bridge.output) => {
                match event {
                    Ok(BridgeEvent::Pong { version, request_id, session_id, generation })
                        if version == BRIDGE_PROTOCOL_VERSION
                            && session_id == bridge.session_id
                            && generation == bridge.generation
                            && pending_heartbeats.remove(&request_id) => {
                            telemetry.heartbeat();
                        }
                    Ok(BridgeEvent::Error { message, .. }) => {
                        accept_error = Some(format!("Redirector bridge failed: {message}"));
                        break;
                    }
                    Ok(BridgeEvent::Stopped { .. }) => {
                        accept_error = Some("Redirector bridge stopped unexpectedly".into());
                        break;
                    }
                    Ok(other) => {
                        accept_error = Some(format!("unexpected Redirector bridge event: {other:?}"));
                        break;
                    }
                    Err(error) => {
                        accept_error = Some(format!("Redirector bridge event channel failed: {error}"));
                        break;
                    }
                }
            }
            accepted = accept_with_capacity(&listener, Arc::clone(&limiter)) => {
                let (stream, permit) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        accept_error = Some(error);
                        break;
                    }
                };
                match redirector_peer_pid(&stream) {
                    Ok(pid) if pid == telemetry.bridge_pid => {}
                    Ok(pid) => {
                        tracing::warn!(
                            pid,
                            expected_pid = telemetry.bridge_pid,
                            "sockscap: rejected flow socket from an unexpected process"
                        );
                        continue;
                    }
                    Err(error) => {
                        tracing::warn!("sockscap: rejected unauthenticated bridge flow: {error}");
                        continue;
                    }
                }
                let scope = Arc::clone(&scope);
                let ctx = Arc::clone(&ctx);
                let flow_stats = Arc::clone(&stats);
                flows.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = serve_flow(stream, scope, block_quic, ctx).await {
                        flow_stats.record_flow_failure();
                        tracing::warn!("sockscap: Redirector flow failed: {error}");
                    }
                });
            }
        }
    }

    let disable_result = stop_bridge(&mut bridge).await;
    flows.shutdown().await;

    disable_result?;
    if let Some(error) = accept_error {
        return Err(error);
    }
    tracing::info!("sockscap: Redirector bridge disabled interception with inert scope");
    Ok(())
}

/// Apply backpressure at the Unix listener instead of accepting and then
/// refusing excess flows. Redirector can keep the connection in its socket
/// backlog briefly while an existing browser flow releases a permit.
pub(super) async fn accept_with_capacity(
    listener: &UnixListener,
    limiter: Arc<tokio::sync::Semaphore>,
) -> Result<(UnixStream, tokio::sync::OwnedSemaphorePermit), String> {
    let permit = limiter
        .acquire_owned()
        .await
        .map_err(|_| "Redirector flow limiter closed".to_string())?;
    let (stream, _) = listener
        .accept()
        .await
        .map_err(|error| format!("accept Redirector flow: {error}"))?;
    Ok((stream, permit))
}
