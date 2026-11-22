//! Standalone macOS Redirector bridge process mode.
//!
//! SocksCap launches the bridge helper as a separate executable. It owns
//! Redirector's control socket and survives long enough to send an
//! inert scope when the UI/backend process disappears. Flow byte streams are
//! forwarded to a separate Unix listener owned by the main process.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::time::Instant;

use taomni_redirector::bridge_protocol::{
    BRIDGE_PROTOCOL_VERSION, BridgeEvent, MAX_MANAGEMENT_LINE, encode_line,
};
use taomni_redirector::identity::{redirector_peer_pid, verify_redirector_peer};

const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(180);
const HEARTBEAT_CHECK: Duration = Duration::from_secs(1);
const LAUNCHER_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

mod management;
mod options;
pub use options::process_start_micros;
use options::{Options, parse_options, validate_socket_path};

struct ShutdownSignals {
    terminate: Signal,
    interrupt: Signal,
    hangup: Signal,
}

impl ShutdownSignals {
    fn new() -> Result<Self, String> {
        let subscribe = |kind| {
            signal(kind).map_err(|error| format!("install Redirector signal handler: {error}"))
        };
        Ok(Self {
            terminate: subscribe(SignalKind::terminate())?,
            interrupt: subscribe(SignalKind::interrupt())?,
            hangup: subscribe(SignalKind::hangup())?,
        })
    }

    async fn recv(&mut self) -> &'static str {
        tokio::select! {
            _ = self.terminate.recv() => "SIGTERM",
            _ = self.interrupt.recv() => "SIGINT",
            _ = self.hangup.recv() => "SIGHUP",
        }
    }
}

struct SocketCleanup(PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub fn run_from_cli(args: impl Iterator<Item = String>, require_module_host: bool) -> i32 {
    let options = match parse_options(args, require_module_host) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("sockscap bridge: {error}");
            return 1;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("sockscap bridge: create runtime: {error}");
            return 1;
        }
    };
    match runtime.block_on(run(options)) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("sockscap bridge: {error}");
            1
        }
    }
}

async fn run(options: Options) -> Result<(), String> {
    validate_socket_path(&options.provider_socket, "provider")?;
    validate_socket_path(&options.flow_socket, "flow")?;
    if !options.redirector.is_file() {
        return Err(format!(
            "Redirector executable is missing: {}",
            options.redirector.display()
        ));
    }
    if options.provider_socket.exists() {
        return Err(format!(
            "refusing to replace existing provider socket path {}",
            options.provider_socket.display()
        ));
    }

    if let Some(reason) = options.exited_owner() {
        return Err(reason);
    }
    let listener = UnixListener::bind(&options.provider_socket).map_err(|error| {
        format!(
            "bind provider socket {}: {error}",
            options.provider_socket.display()
        )
    })?;
    let _cleanup = SocketCleanup(options.provider_socket.clone());
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        &options.provider_socket,
        std::fs::Permissions::from_mode(0o600),
    )
    .map_err(|error| format!("secure provider socket: {error}"))?;

    let mut signals = ShutdownSignals::new()?;
    let mut launcher = Command::new(&options.redirector)
        .arg(&options.provider_socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        // The upstream app can wait indefinitely for macOS user approval.
        // Every ordinary bridge exit must therefore terminate it; the explicit
        // cleanup below reaps it, while kill_on_drop covers early unwinding.
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            format!(
                "launch signed Redirector {}: {error}",
                options.redirector.display()
            )
        })?;

    let result = run_session(&options, &listener, &mut launcher, &mut signals).await;
    terminate_launcher(&mut launcher).await;
    result
}

async fn run_session(
    options: &Options,
    listener: &UnixListener,
    launcher: &mut Child,
    signals: &mut ShutdownSignals,
) -> Result<(), String> {
    let (control, provider_pid) = accept_verified_control(
        listener,
        CONTROL_CONNECT_TIMEOUT,
        launcher,
        options,
        signals,
    )
    .await?;

    management::manage(
        options,
        listener,
        launcher,
        signals,
        (control, provider_pid),
        BufReader::new(tokio::io::stdin()),
        BufWriter::new(tokio::io::stdout()),
    )
    .await
}

async fn accept_verified_control(
    listener: &UnixListener,
    timeout: Duration,
    launcher: &mut Child,
    options: &Options,
    signals: &mut ShutdownSignals,
) -> Result<(UnixStream, u32), String> {
    let deadline = Instant::now() + timeout;
    let mut parent_check = tokio::time::interval(HEARTBEAT_CHECK);
    parent_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut launcher_running = launcher
        .try_wait()
        .map_err(|error| format!("inspect Redirector launcher: {error}"))?
        .is_none();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("timed out waiting for a verified Redirector control channel".into());
        }
        let accepted = tokio::select! {
            accepted = listener.accept() => Some(
                accepted.map_err(|error| format!("accept Redirector control channel: {error}"))?
            ),
            status = launcher.wait(), if launcher_running => {
                launcher_running = false;
                match status {
                    Ok(status) if status.success() => {
                        // The upstream coordinator exits after starting the NE
                        // tunnel; the Provider connection can arrive just after.
                        eprintln!("sockscap bridge: Redirector launcher exited successfully");
                        None
                    }
                    Ok(status) => return Err(format!("Redirector launcher exited with {status}")),
                    Err(error) => return Err(format!("Redirector launcher wait failed: {error}")),
                }
            }
            _ = parent_check.tick() => {
                if let Some(reason) = options.exited_owner() {
                    return Err(format!("{reason} while waiting for Redirector approval"));
                }
                None
            }
            name = signals.recv() => return Err(format!("received {name} while waiting for Redirector approval")),
            _ = tokio::time::sleep(remaining) => {
                return Err(
                    "timed out waiting for Mitmproxy Redirector; approve its System Extension and network configuration in System Settings, then retry"
                        .into()
                );
            }
        };
        let Some((stream, _)) = accepted else {
            continue;
        };
        match verify_redirector_peer(&stream) {
            Ok(pid) => return Ok((stream, pid)),
            Err(error) => {
                eprintln!("sockscap bridge: rejected unverified control peer: {error}");
            }
        }
    }
}

async fn terminate_launcher(launcher: &mut Child) {
    match launcher.try_wait() {
        Ok(Some(_)) => return,
        Ok(None) => {}
        Err(error) => {
            eprintln!("sockscap bridge: inspect Redirector launcher during cleanup: {error}");
        }
    }
    if let Some(pid) = launcher.id() {
        // Let Swift unwind a pending SystemExtension continuation first.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    if tokio::time::timeout(LAUNCHER_EXIT_TIMEOUT, launcher.wait())
        .await
        .is_err()
    {
        let _ = launcher.start_kill();
        let _ = launcher.wait().await;
    }
}

async fn proxy_flow(
    mut provider_flow: UnixStream,
    flow_socket: &Path,
    provider_pid: u32,
    parent_pid: u32,
) -> Result<(), String> {
    let mut app_flow = UnixStream::connect(flow_socket).await.map_err(|error| {
        format!(
            "connect Taomni flow socket {} for provider pid {provider_pid}: {error}",
            flow_socket.display()
        )
    })?;
    let peer_pid = redirector_peer_pid(&app_flow)?;
    if peer_pid != parent_pid {
        return Err(format!(
            "Taomni flow socket peer pid {peer_pid} does not match parent pid {parent_pid}"
        ));
    }
    tokio::io::copy_bidirectional(&mut provider_flow, &mut app_flow)
        .await
        .map(|_| ())
        .map_err(|error| format!("forward Redirector flow: {error}"))
}

async fn read_management_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut String,
) -> Result<usize, std::io::Error> {
    let size = (&mut *reader)
        .take((MAX_MANAGEMENT_LINE + 1) as u64)
        .read_line(line)
        .await?;
    if size > MAX_MANAGEMENT_LINE || (size > 0 && !line.ends_with('\n')) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Redirector bridge command exceeds {MAX_MANAGEMENT_LINE} bytes or is unterminated"
            ),
        ));
    }
    Ok(size)
}

async fn write_event<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    event: &BridgeEvent,
) -> Result<(), String> {
    output
        .write_all(encode_line(event)?.as_bytes())
        .await
        .map_err(|error| format!("write bridge event: {error}"))?;
    output
        .flush()
        .await
        .map_err(|error| format!("flush bridge event: {error}"))
}

async fn write_error<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    request_id: Option<u64>,
    message: String,
) -> Result<(), String> {
    write_event(
        output,
        &BridgeEvent::Error {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id,
            message,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_paths_must_be_private_tmp_names() {
        assert!(
            validate_socket_path(
                Path::new("/tmp/taomni-redirector-provider-a.sock"),
                "provider"
            )
            .is_ok()
        );
        assert!(validate_socket_path(Path::new("/tmp/unrelated.sock"), "provider").is_err());
        assert!(
            validate_socket_path(Path::new("/var/tmp/taomni-redirector-x.sock"), "flow").is_err()
        );
    }

    #[tokio::test]
    async fn pending_approval_launcher_is_terminated_and_reaped() {
        let mut launcher = Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        assert!(launcher.id().is_some());

        terminate_launcher(&mut launcher).await;

        assert!(launcher.try_wait().unwrap().is_some());
    }
}
