use super::lifetime::RedirectorStartError;
use super::limits::BRIDGE_EXIT_TIMEOUT;
use super::limits::CONTROL_CONNECT_TIMEOUT;
use super::limits::STOP_TIMEOUT;
use crate::sockscap::redirector::bridge_protocol::BRIDGE_PROTOCOL_VERSION;
use crate::sockscap::redirector::bridge_protocol::BridgeCommand;
use crate::sockscap::redirector::bridge_protocol::BridgeEvent;
use crate::sockscap::redirector::bridge_protocol::MAX_MANAGEMENT_LINE;
use crate::sockscap::redirector::bridge_protocol::decode_line;
use crate::sockscap::redirector::bridge_protocol::encode_line;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::io::BufWriter;
use tokio::net::UnixListener;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;
use tokio::process::Command;

pub(super) struct SocketCleanup(pub(super) PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) struct BridgeSession {
    pub(super) child: Child,
    pub(super) input: BufWriter<ChildStdin>,
    pub(super) output: BufReader<ChildStdout>,
    pub(super) session_id: String,
    pub(super) provider_pid: u32,
    pub(super) generation: u64,
    pub(super) next_request_id: u64,
}

pub(super) fn random_socket_path(label: &str) -> PathBuf {
    PathBuf::from(format!(
        "/tmp/taomni-redirector-{label}-{}.sock",
        uuid::Uuid::new_v4().simple()
    ))
}

pub(super) fn bind_private_listener(path: &PathBuf) -> Result<UnixListener, String> {
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("bind Redirector IPC {}: {error}", path.display()))?;
    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        let _ = std::fs::remove_file(path);
        return Err(format!("secure Redirector IPC {}: {error}", path.display()));
    }
    Ok(listener)
}

fn legacy_bridge_executable() -> Result<PathBuf, String> {
    const NAME: &str = "sockscap-redirector-bridge";
    let app =
        std::env::current_exe().map_err(|error| format!("resolve Taomni executable: {error}"))?;
    let alongside = app.with_file_name(NAME);
    if cfg!(debug_assertions) && alongside.is_file() {
        return Ok(alongside);
    }
    if let Some(contents) = app.parent().and_then(std::path::Path::parent) {
        for relative in [
            "Resources/resources/sockscap/macos",
            "Resources/sockscap/macos",
        ] {
            let bundled = contents.join(relative).join(NAME);
            if bundled.is_file() {
                return Ok(bundled);
            }
        }
    }
    if alongside.is_file() {
        return Ok(alongside);
    }
    Err(format!("SocksCap is missing its Redirector helper: {NAME}"))
}

/// An enabled package advertises its secondary entrypoint over the normal
/// host channel. The old standalone helper can still clear a stranded scope.
async fn spawn_bridge(
    registry: &std::sync::Arc<crate::plugin::PluginRegistry>,
    recovery: bool,
    redirector: &std::path::Path,
    provider_socket: &std::path::Path,
    flow_socket: &std::path::Path,
) -> Result<Child, String> {
    use crate::plugin::LifecycleState;
    use taomni_sockscap_api::{REDIRECTOR_BRIDGE_ARG, RUNTIME_INFO, RuntimeInfo, SLUG};
    let provider = provider_socket.to_path_buf();
    let flow = flow_socket.to_path_buf();
    let redirector = redirector.to_path_buf();
    let spawn = move |mut command: Command| {
        command
            .arg("--provider-socket")
            .arg(provider)
            .arg("--flow-socket")
            .arg(flow)
            .arg("--redirector")
            .arg(redirector)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(false)
            .spawn()
    };
    if let Some(record) = registry.get(SLUG) {
        if record.state == LifecycleState::Enabled
            && record.manifest.commands.contains(RUNTIME_INFO)
        {
            let info: RuntimeInfo =
                crate::sockscap::module_host::invoke(registry, RUNTIME_INFO, serde_json::json!({}))
                    .await?;
            if info.redirector_bridge_protocol != Some(BRIDGE_PROTOCOL_VERSION) {
                return Err(
                    "The installed SocksCap module has an incompatible Redirector bridge".into(),
                );
            }
            let birth = info
                .host_start_micros
                .filter(|birth| *birth > 0)
                .ok_or("The SocksCap module did not identify its running host")?;
            let registry = registry.clone();
            return tokio::task::spawn_blocking(move || {
                registry.launch_verified_mode(
                    SLUG,
                    &record.manifest.version,
                    RUNTIME_INFO,
                    |executable| {
                        let mut command = Command::new(executable);
                        command
                            .arg(REDIRECTOR_BRIDGE_ARG)
                            .arg("--module-host")
                            .arg(format!("{}:{birth}", info.host_pid));
                        spawn(command)
                    },
                )
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string());
        }
        if record.state != LifecycleState::Enabled && !recovery {
            return Err("Enable the SocksCap module before starting capture".into());
        }
    } else if !recovery {
        return Err("Install and enable the SocksCap module before starting capture".into());
    }
    spawn(Command::new(legacy_bridge_executable()?))
        .map_err(|error| format!("launch legacy Redirector bridge: {error}"))
}

pub(super) async fn launch_bridge(
    registry: &std::sync::Arc<crate::plugin::PluginRegistry>,
    recovery: bool,
    redirector: &std::path::Path,
    provider_socket: &std::path::Path,
    flow_socket: &std::path::Path,
    actions: &[String],
    session_id: &str,
) -> Result<BridgeSession, RedirectorStartError> {
    if actions.is_empty() {
        return Err(RedirectorStartError::before_scope(
            "Redirector bridge actions must not be empty",
        ));
    }
    if session_id.trim().is_empty() {
        return Err(RedirectorStartError::before_scope(
            "Redirector bridge session id must not be empty",
        ));
    }
    let mut child =
        spawn_bridge(registry, recovery, redirector, provider_socket, flow_socket).await?;
    let Some(stdin) = child.stdin.take() else {
        terminate_bridge_child(&mut child).await;
        return Err(RedirectorStartError::before_scope(
            "Redirector bridge stdin is unavailable",
        ));
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_bridge_child(&mut child).await;
        return Err(RedirectorStartError::before_scope(
            "Redirector bridge stdout is unavailable",
        ));
    };
    let mut input = BufWriter::new(stdin);
    let mut output = BufReader::new(stdout);

    let ready =
        match tokio::time::timeout(CONTROL_CONNECT_TIMEOUT, read_bridge_event(&mut output)).await {
            Ok(Ok(event)) => event,
            Ok(Err(error)) => {
                terminate_bridge_child(&mut child).await;
                return Err(RedirectorStartError::before_scope(error));
            }
            Err(_) => {
                terminate_bridge_child(&mut child).await;
                return Err(RedirectorStartError::before_scope(
                    "timed out waiting for Redirector bridge control readiness",
                ));
            }
        };
    let provider_pid = match ready {
        BridgeEvent::ControlReady {
            version,
            provider_pid,
        } if version == BRIDGE_PROTOCOL_VERSION => provider_pid,
        BridgeEvent::Error { message, .. } => {
            terminate_bridge_child(&mut child).await;
            return Err(RedirectorStartError::before_scope(message));
        }
        event => {
            terminate_bridge_child(&mut child).await;
            return Err(RedirectorStartError::before_scope(format!(
                "unexpected Redirector bridge readiness event: {event:?}"
            )));
        }
    };

    let session_id = session_id.to_string();
    if let Err(error) = write_bridge_command(
        &mut input,
        &BridgeCommand::Apply {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: 1,
            session_id: session_id.clone(),
            generation: 1,
            actions: actions.to_vec(),
        },
    )
    .await
    {
        terminate_bridge_child(&mut child).await;
        return Err(RedirectorStartError::after_apply(error));
    }
    let applied = match tokio::time::timeout(STOP_TIMEOUT, read_bridge_event(&mut output)).await {
        Ok(Ok(event)) => event,
        Ok(Err(error)) => {
            terminate_bridge_child(&mut child).await;
            return Err(RedirectorStartError::after_apply(error));
        }
        Err(_) => {
            terminate_bridge_child(&mut child).await;
            return Err(RedirectorStartError::after_apply(
                "timed out waiting for Redirector bridge scope apply",
            ));
        }
    };
    match applied {
        BridgeEvent::Applied {
            version,
            request_id,
            session_id: applied_session,
            generation,
        } if version == BRIDGE_PROTOCOL_VERSION
            && request_id == 1
            && applied_session == session_id
            && generation == 1 => {}
        BridgeEvent::Error { message, .. } => {
            terminate_bridge_child(&mut child).await;
            return Err(RedirectorStartError::after_apply(message));
        }
        event => {
            terminate_bridge_child(&mut child).await;
            return Err(RedirectorStartError::after_apply(format!(
                "unexpected Redirector bridge apply event: {event:?}"
            )));
        }
    }

    Ok(BridgeSession {
        child,
        input,
        output,
        session_id,
        provider_pid,
        generation: 1,
        next_request_id: 2,
    })
}

pub(super) async fn stop_bridge(bridge: &mut BridgeSession) -> Result<(), String> {
    let request_id = bridge.next_request_id;
    bridge.next_request_id = bridge.next_request_id.saturating_add(1);
    if let Err(error) = write_bridge_command(
        &mut bridge.input,
        &BridgeCommand::Stop {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id,
            session_id: bridge.session_id.clone(),
            generation: bridge.generation,
        },
    )
    .await
    {
        // Closing the management pipe is itself a watchdog trigger. Wait for
        // the bridge's inert cleanup instead of abandoning the child.
        bridge.input.shutdown().await.ok();
        terminate_bridge_child(&mut bridge.child).await;
        return Err(error);
    }

    let stopped = tokio::time::timeout(STOP_TIMEOUT, async {
        loop {
            match read_bridge_event(&mut bridge.output).await? {
                BridgeEvent::Pong { .. } => continue,
                BridgeEvent::Stopped {
                    version,
                    request_id: stopped_request_id,
                    session_id,
                    generation,
                } if version == BRIDGE_PROTOCOL_VERSION
                    && stopped_request_id == request_id
                    && session_id == bridge.session_id
                    && generation == bridge.generation =>
                {
                    return Ok(());
                }
                BridgeEvent::Error { message, .. } => return Err(message),
                event => return Err(format!("unexpected bridge stop event: {event:?}")),
            }
        }
    })
    .await;

    let stopped = match stopped {
        Ok(Ok(stopped)) => stopped,
        Ok(Err(error)) => {
            terminate_bridge_child(&mut bridge.child).await;
            return Err(error);
        }
        Err(_) => {
            terminate_bridge_child(&mut bridge.child).await;
            return Err("timed out waiting for Redirector bridge inert stop".into());
        }
    };

    if tokio::time::timeout(BRIDGE_EXIT_TIMEOUT, bridge.child.wait())
        .await
        .is_err()
    {
        let _ = bridge.child.start_kill();
        let _ = bridge.child.wait().await;
    }
    Ok(stopped)
}

pub(super) async fn terminate_bridge_child(child: &mut Child) {
    if let Some(pid) = child.id() {
        // SIGTERM gives the bridge a chance to install the inert scope. If it
        // is still in early startup, termination is safe because no business
        // scope has been applied yet.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    if tokio::time::timeout(STOP_TIMEOUT, child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

pub(super) async fn write_bridge_command<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    command: &BridgeCommand,
) -> Result<(), String> {
    writer
        .write_all(encode_line(command)?.as_bytes())
        .await
        .map_err(|error| format!("write Redirector bridge command: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("flush Redirector bridge command: {error}"))
}

pub(super) async fn read_bridge_event<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<BridgeEvent, String> {
    let mut line = String::new();
    let size = (&mut *reader)
        .take((MAX_MANAGEMENT_LINE + 1) as u64)
        .read_line(&mut line)
        .await
        .map_err(|error| format!("read Redirector bridge event: {error}"))?;
    if size == 0 {
        return Err("Redirector bridge event channel closed".into());
    }
    if size > MAX_MANAGEMENT_LINE || !line.ends_with('\n') {
        return Err(format!(
            "Redirector bridge event exceeds {MAX_MANAGEMENT_LINE} bytes or is unterminated"
        ));
    }
    decode_line(&line).map_err(|error| format!("decode Redirector bridge event: {error}"))
}
