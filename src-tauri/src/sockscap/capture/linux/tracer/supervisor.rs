use super::event_loop::spawn_desktop;
use super::event_loop::spawn_terminal;
use super::event_loop::trace_loop;
use super::event_loop::wake_trace_loop;
use super::flows::FlowQueue;
use super::flows::ProcessIdentity;
use super::limits::TRACE_START_TIMEOUT;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread::JoinHandle;

pub(super) enum TraceCommand {
    SpawnDesktop {
        launcher: PathBuf,
        launch: LaunchCommand,
        response: mpsc::Sender<Result<u32, String>>,
    },
    SpawnTerminal {
        launcher: PathBuf,
        launch: LaunchCommand,
        cols: u16,
        rows: u16,
        response: mpsc::Sender<Result<SpawnedTerminal, String>>,
    },
    Register {
        pid: libc::pid_t,
        identity: ProcessIdentity,
        execs_until_running: u8,
        ready: mpsc::Sender<Result<(), String>>,
    },
    Shutdown,
}

pub type SpawnedTerminal = (u32, crate::terminal::pty::PtyHandle, Box<dyn Read + Send>);

#[derive(Debug, Clone)]
pub struct LaunchCommand {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_directory: Option<PathBuf>,
    pub environment: Vec<(OsString, OsString)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchStatus {
    Preparing,
    Running,
    Exited,
    Failed(String),
}

#[derive(Debug, Clone)]
pub(super) struct LaunchLifecycle {
    pub(super) status: LaunchStatus,
    pub(super) execs_until_running: u8,
}

impl LaunchLifecycle {
    pub(super) fn new(execs_until_running: u8) -> Self {
        Self {
            status: LaunchStatus::Preparing,
            execs_until_running,
        }
    }

    pub(super) fn observe_exec(&mut self) {
        if !matches!(self.status, LaunchStatus::Preparing) {
            return;
        }
        self.execs_until_running = self.execs_until_running.saturating_sub(1);
        if self.execs_until_running == 0 {
            self.status = LaunchStatus::Running;
        }
    }

    pub(super) fn finish(&mut self, failure: String) {
        self.status = if matches!(self.status, LaunchStatus::Preparing) {
            LaunchStatus::Failed(failure)
        } else {
            LaunchStatus::Exited
        };
    }
}

pub struct TracerSupervisor {
    pub(super) commands: mpsc::Sender<TraceCommand>,
    // `waitpid(WNOHANG)` cannot be selected alongside the command channel. A
    // self-pipe gives both command senders and SIGCHLD one loss-tolerant wakeup
    // path, while the loop still drains every queued wait status.
    pub(super) wake_writer: UnixStream,
    // Keep the peer alive until the signal hook is unregistered. The hook's
    // async write must not observe a closed UnixStream during shutdown.
    pub(super) _wake_reader_guard: UnixStream,
    pub(super) signal_registration: Option<signal_hook::SigId>,
    pub(super) launch_lifecycles: Arc<Mutex<HashMap<libc::pid_t, LaunchLifecycle>>>,
    pub(super) thread: Option<JoinHandle<()>>,
}

impl TracerSupervisor {
    pub fn start(relay_port: u16, ipv6_ready: bool, flows: Arc<FlowQueue>) -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let (wake_reader, wake_writer) = UnixStream::pair()
            .map_err(|error| format!("create SocksCap ptrace wake socket: {error}"))?;
        let wake_reader_guard = wake_reader
            .try_clone()
            .map_err(|error| format!("clone SocksCap ptrace read guard: {error}"))?;
        let signal_writer = wake_writer
            .try_clone()
            .map_err(|error| format!("clone SocksCap ptrace wake socket: {error}"))?;
        let signal_registration = signal_hook::low_level::pipe::register(
            signal_hook::consts::signal::SIGCHLD,
            signal_writer,
        )
        .map_err(|error| format!("register SocksCap SIGCHLD wakeup: {error}"))?;
        let launch_lifecycles = Arc::new(Mutex::new(HashMap::new()));
        let thread_lifecycles = Arc::clone(&launch_lifecycles);
        let thread = match std::thread::Builder::new()
            .name("sockscap-ptrace".into())
            .spawn(move || {
                trace_loop(
                    receiver,
                    wake_reader,
                    flows,
                    relay_port,
                    ipv6_ready,
                    thread_lifecycles,
                )
            }) {
            Ok(thread) => thread,
            Err(error) => {
                signal_hook::low_level::unregister(signal_registration);
                return Err(format!("spawn SocksCap ptrace supervisor: {error}"));
            }
        };
        Ok(Self {
            commands,
            wake_writer,
            _wake_reader_guard: wake_reader_guard,
            signal_registration: Some(signal_registration),
            launch_lifecycles,
            thread: Some(thread),
        })
    }

    pub fn spawn_desktop(&self, launcher: &Path, launch: &LaunchCommand) -> Result<u32, String> {
        let (response, result) = mpsc::channel();
        self.commands
            .send(TraceCommand::SpawnDesktop {
                launcher: launcher.to_path_buf(),
                launch: launch.clone(),
                response,
            })
            .map_err(|_| "SocksCap ptrace supervisor stopped before launch".to_string())?;
        wake_trace_loop(&self.wake_writer);
        result
            .recv_timeout(TRACE_START_TIMEOUT)
            .map_err(|_| "timed out waiting for the SocksCap launcher".to_string())?
    }

    pub fn spawn_terminal(
        &self,
        launcher: &Path,
        launch: &LaunchCommand,
        cols: u16,
        rows: u16,
    ) -> Result<SpawnedTerminal, String> {
        let (response, result) = mpsc::channel();
        self.commands
            .send(TraceCommand::SpawnTerminal {
                launcher: launcher.to_path_buf(),
                launch: launch.clone(),
                cols,
                rows,
                response,
            })
            .map_err(|_| "SocksCap ptrace supervisor stopped before terminal launch".to_string())?;
        wake_trace_loop(&self.wake_writer);
        result
            .recv_timeout(TRACE_START_TIMEOUT)
            .map_err(|_| "timed out waiting for the SocksCap terminal launcher".to_string())?
    }

    pub fn register_root(
        &self,
        pid: u32,
        identity: ProcessIdentity,
        execs_until_running: u8,
    ) -> Result<(), String> {
        let (ready, response) = mpsc::channel();
        self.commands
            .send(TraceCommand::Register {
                pid: pid as libc::pid_t,
                identity,
                execs_until_running,
                ready,
            })
            .map_err(|_| "SocksCap ptrace supervisor stopped before launch".to_string())?;
        wake_trace_loop(&self.wake_writer);
        response.recv_timeout(TRACE_START_TIMEOUT).map_err(|_| {
            "timed out waiting for the launched application to enter ptrace".to_string()
        })?
    }

    pub fn launch_status(&self, pid: u32) -> Option<LaunchStatus> {
        self.launch_lifecycles
            .lock()
            .ok()?
            .get(&(pid as libc::pid_t))
            .map(|lifecycle| lifecycle.status.clone())
    }

    pub fn shutdown(&mut self) {
        if self.commands.send(TraceCommand::Shutdown).is_ok() {
            wake_trace_loop(&self.wake_writer);
        }
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::warn!("SocksCap ptrace supervisor panicked during shutdown");
        }
        if let Some(signal_registration) = self.signal_registration.take() {
            signal_hook::low_level::unregister(signal_registration);
        }
    }
}

impl Drop for TracerSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}
