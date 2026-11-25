//! Supervise the authenticated Provider and put its scope back to inert on exit.

use super::{
    HEARTBEAT_CHECK, Options, ShutdownSignals, proxy_flow, read_management_line, write_error,
    write_event,
};
use std::time::Duration;
use taomni_redirector::{
    bridge_protocol::{BRIDGE_PROTOCOL_VERSION, BridgeCommand, BridgeEvent, decode_line},
    identity::redirector_peer_pid,
    inert_actions,
    ipc::send_intercept_config,
};
use tokio::{
    io::{AsyncBufRead, AsyncWrite, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    process::Child,
    task::JoinSet,
    time::Instant,
};

const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(10);
const DISABLE_DRAIN: Duration = Duration::from_millis(300);

pub(super) async fn manage(
    options: &Options,
    listener: &UnixListener,
    launcher: &mut Child,
    signals: &mut ShutdownSignals,
    (mut control, provider_pid): (UnixStream, u32),
    mut input: impl AsyncBufRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> Result<(), String> {
    write_event(
        &mut output,
        &BridgeEvent::ControlReady {
            version: BRIDGE_PROTOCOL_VERSION,
            provider_pid,
        },
    )
    .await?;

    let mut heartbeat = tokio::time::interval(HEARTBEAT_CHECK);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_management = Instant::now();
    let mut session_id: Option<String> = None;
    let mut generation = 0u64;
    let mut stop_request_id = 0u64;
    let mut active = false;
    let mut flows = JoinSet::new();
    let mut stop_reason = "management stop".to_string();
    let mut launcher_running = launcher
        .try_wait()
        .map_err(|error| format!("inspect Redirector launcher: {error}"))?
        .is_none();

    let management_result: Result<(), String> = async {
        loop {
            let mut line = String::new();
            tokio::select! {
            read = read_management_line(&mut input, &mut line) => {
                let size = read.map_err(|error| format!("read management command: {error}"))?;
                if size == 0 {
                    stop_reason = "parent management pipe closed".into();
                    break;
                }
                last_management = Instant::now();
                let command: BridgeCommand = match decode_line(&line) {
                    Ok(command) => command,
                    Err(error) => {
                        write_error(&mut output, None, format!("invalid management command: {error}")).await?;
                        stop_reason = "invalid management command".into();
                        break;
                    }
                };
                if command.version() != BRIDGE_PROTOCOL_VERSION {
                    write_error(
                        &mut output,
                        None,
                        format!(
                            "management protocol version {} is unsupported (expected {BRIDGE_PROTOCOL_VERSION})",
                            command.version()
                        ),
                    )
                    .await?;
                    stop_reason = "protocol version mismatch".into();
                    break;
                }
                match command {
                    BridgeCommand::Apply { request_id, session_id: requested, generation: requested_generation, actions, .. } => {
                        if active || requested.trim().is_empty() || requested_generation == 0 {
                            write_error(&mut output, Some(request_id), "duplicate, empty, or zero-generation bridge session".into()).await?;
                            stop_reason = "invalid Apply command".into();
                            break;
                        }
                        if let Some(reason) = options.exited_owner() {
                            stop_reason = reason;
                            break;
                        }
                        send_intercept_config(&mut control, &actions)
                            .await
                            .map_err(|error| format!("apply Redirector scope: {error}"))?;
                        session_id = Some(requested.clone());
                        generation = requested_generation;
                        active = true;
                        write_event(
                            &mut output,
                            &BridgeEvent::Applied {
                                version: BRIDGE_PROTOCOL_VERSION,
                                request_id,
                                session_id: requested,
                                generation,
                            },
                        )
                        .await?;
                    }
                    BridgeCommand::Ping { request_id, session_id: requested, generation: requested_generation, .. } => {
                        if session_id.as_deref() != Some(requested.as_str()) || generation != requested_generation {
                            write_error(&mut output, Some(request_id), "heartbeat session/generation mismatch".into()).await?;
                            stop_reason = "heartbeat session mismatch".into();
                            break;
                        }
                        write_event(
                            &mut output,
                            &BridgeEvent::Pong {
                                version: BRIDGE_PROTOCOL_VERSION,
                                request_id,
                                session_id: requested,
                                generation,
                            },
                        )
                        .await?;
                    }
                    BridgeCommand::Stop { request_id, session_id: requested, generation: requested_generation, .. } => {
                        stop_request_id = request_id;
                        if session_id.as_deref() != Some(requested.as_str()) || generation != requested_generation {
                            write_error(&mut output, Some(request_id), "stop session/generation mismatch".into()).await?;
                            stop_reason = "stop session/generation mismatch".into();
                        }
                        break;
                    }
                }
            }
            accepted = listener.accept(), if active => {
                let (provider_flow, _) = accepted
                    .map_err(|error| format!("accept Redirector flow: {error}"))?;
                let flow_pid = match redirector_peer_pid(&provider_flow) {
                    Ok(pid) if pid == provider_pid => pid,
                    Ok(pid) => {
                        eprintln!(
                            "sockscap bridge: rejected flow from Redirector pid {pid}; control pid is {provider_pid}"
                        );
                        continue;
                    }
                    Err(error) => {
                        eprintln!("sockscap bridge: rejected unverified flow peer: {error}");
                        continue;
                    }
                };
                let flow_socket = options.flow_socket.clone();
                let parent_pid = options.parent_pid;
                flows.spawn(async move {
                    proxy_flow(provider_flow, &flow_socket, flow_pid, parent_pid).await
                });
            }
            ready = control.readable(), if active => {
                ready.map_err(|error| format!("monitor Redirector control channel: {error}"))?;
                let mut unexpected = [0u8; 1];
                match control.try_read(&mut unexpected) {
                    Ok(0) => {
                        stop_reason = "Redirector Provider closed the control channel".into();
                        break;
                    }
                    Ok(_) => {
                        stop_reason = "Redirector Provider sent unexpected control data".into();
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) => {
                        stop_reason = format!("Redirector control channel failed: {error}");
                        break;
                    }
                }
            }
            name = signals.recv() => {
                stop_reason = name.into();
                break;
            }
            _ = heartbeat.tick() => {
                if let Some(reason) = options.exited_owner() {
                    stop_reason = reason;
                    break;
                }
                if last_management.elapsed() >= HEARTBEAT_TIMEOUT {
                    stop_reason = format!(
                        "management heartbeat timed out after {}s",
                        HEARTBEAT_TIMEOUT.as_secs()
                    );
                    break;
                }
            }
                status = launcher.wait(), if launcher_running => {
                    launcher_running = false;
                    match status {
                        Ok(status) if status.success() => {
                            eprintln!("sockscap bridge: Redirector launcher exited successfully");
                        }
                        Ok(status) => {
                            return Err(format!("Redirector launcher exited with {status}"));
                        }
                        Err(error) => {
                            return Err(format!("Redirector launcher wait failed: {error}"));
                        }
                    }
                }
                joined = flows.join_next(), if !flows.is_empty() => {
                    if let Some(Err(error)) = joined {
                        eprintln!("sockscap bridge: flow forwarding task failed: {error}");
                    }
                }
            }
        }
        #[allow(unreachable_code)]
        Ok(())
    }
    .await;

    if let Err(error) = &management_result {
        stop_reason = error.clone();
    }

    eprintln!("sockscap bridge: disabling interception ({stop_reason})");
    let disable_result = send_intercept_config(&mut control, &inert_actions())
        .await
        .map_err(|error| format!("disable Redirector interception: {error}"));
    tokio::time::sleep(DISABLE_DRAIN).await;
    let _ = control.shutdown().await;
    flows.shutdown().await;

    if let Err(error) = disable_result {
        let _ = write_error(&mut output, Some(stop_request_id), error.clone()).await;
        return Err(error);
    }
    if let Err(error) = management_result {
        let _ = write_error(&mut output, Some(stop_request_id), error.clone()).await;
        return Err(error);
    }
    write_event(
        &mut output,
        &BridgeEvent::Stopped {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: stop_request_id,
            session_id: session_id.unwrap_or_default(),
            generation,
        },
    )
    .await
}

#[cfg(test)]
mod tests;
