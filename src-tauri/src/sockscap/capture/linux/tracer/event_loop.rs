use super::flows::FlowQueue;
use super::flows::ProcessIdentity;
use super::network::handle_connect;
use super::network::handle_socket;
use super::process::kill_tracee;
use super::process::ptrace_call;
use super::process::ptrace_resume;
#[cfg(any(
    target_arch = "x86_64",
    target_arch = "aarch64",
    not(any(target_arch = "x86_64", target_arch = "aarch64"))
))]
use super::registers::syscall_registers;
use super::supervisor::LaunchCommand;
use super::supervisor::LaunchLifecycle;
use super::supervisor::SpawnedTerminal;
use super::supervisor::TraceCommand;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;

pub(super) struct TraceState {
    pub(super) identities: HashMap<libc::pid_t, ProcessIdentity>,
    pub(super) initialized: HashSet<libc::pid_t>,
    pub(super) launch_ready: HashMap<libc::pid_t, mpsc::Sender<Result<(), String>>>,
    pub(super) deferred_statuses: HashMap<libc::pid_t, libc::c_int>,
    pub(super) socket_types: HashMap<String, libc::c_int>,
    pub(super) launch_lifecycles: Arc<Mutex<HashMap<libc::pid_t, LaunchLifecycle>>>,
}

impl TraceState {
    pub(super) fn new(
        launch_lifecycles: Arc<Mutex<HashMap<libc::pid_t, LaunchLifecycle>>>,
    ) -> Self {
        Self {
            identities: HashMap::new(),
            initialized: HashSet::new(),
            launch_ready: HashMap::new(),
            deferred_statuses: HashMap::new(),
            socket_types: HashMap::new(),
            launch_lifecycles,
        }
    }

    pub(super) fn remove(&mut self, pid: libc::pid_t, detail: &str) {
        self.identities.remove(&pid);
        self.initialized.remove(&pid);
        self.deferred_statuses.remove(&pid);
        if let Some(ready) = self.launch_ready.remove(&pid) {
            let _ = ready.send(Err(detail.to_string()));
        }
        if let Ok(mut lifecycles) = self.launch_lifecycles.lock()
            && let Some(lifecycle) = lifecycles.get_mut(&pid)
        {
            lifecycle.finish(detail.to_string());
        }
    }

    pub(super) fn observe_exec(&self, pid: libc::pid_t) {
        if let Ok(mut lifecycles) = self.launch_lifecycles.lock()
            && let Some(lifecycle) = lifecycles.get_mut(&pid)
        {
            lifecycle.observe_exec();
        }
    }
}

pub(super) fn trace_loop(
    receiver: mpsc::Receiver<TraceCommand>,
    mut wake_reader: UnixStream,
    flows: Arc<FlowQueue>,
    relay_port: u16,
    ipv6_ready: bool,
    launch_lifecycles: Arc<Mutex<HashMap<libc::pid_t, LaunchLifecycle>>>,
) {
    let mut state = TraceState::new(launch_lifecycles);
    loop {
        while let Ok(command) = receiver.try_recv() {
            if handle_trace_command(command, &mut state) {
                return;
            }
        }

        let mut handled_event = false;
        let registered_deferred = state
            .deferred_statuses
            .keys()
            .filter(|pid| state.identities.contains_key(pid))
            .copied()
            .collect::<Vec<_>>();
        for pid in registered_deferred {
            let Some(status) = state.deferred_statuses.remove(&pid) else {
                continue;
            };
            handled_event = true;
            handle_wait_status(pid, status, &mut state, &flows, relay_port, ipv6_ready);
        }

        loop {
            let mut status = 0;
            let waited = unsafe {
                libc::waitpid(
                    -1,
                    &mut status,
                    libc::WNOHANG | libc::WUNTRACED | libc::__WALL | libc::__WNOTHREAD,
                )
            };
            if waited == 0 {
                break;
            }
            if waited < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                if error.raw_os_error() != Some(libc::ECHILD) {
                    tracing::warn!("wait for traced process tree: {error}");
                }
                break;
            }
            handled_event = true;
            if state.identities.contains_key(&waited) {
                handle_wait_status(waited, status, &mut state, &flows, relay_port, ipv6_ready);
            } else {
                // A launcher can enter its initial SIGSTOP between the spawn
                // response and Register command. A clone child can likewise
                // stop before its parent's event is consumed. Keep that one
                // status until the tracee identity becomes available.
                state.deferred_statuses.insert(waited, status);
            }
        }

        if handled_event {
            continue;
        }
        if let Err(error) = wait_for_trace_wake(&mut wake_reader) {
            tracing::warn!("wait for SocksCap ptrace activity: {error}");
            return;
        }
    }
}

pub(super) fn wake_trace_loop(writer: &UnixStream) {
    let byte = b'X';
    unsafe {
        libc::send(
            writer.as_raw_fd(),
            (&byte as *const u8).cast(),
            1,
            libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
        );
    }
}

pub(super) fn wait_for_trace_wake(reader: &mut UnixStream) -> std::io::Result<()> {
    let mut buffer = [0u8; 256];
    match reader.read(&mut buffer) {
        Ok(0) => Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "SocksCap ptrace wake socket closed",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => Ok(()),
        Err(error) => Err(error),
    }
}

pub(super) fn handle_trace_command(command: TraceCommand, state: &mut TraceState) -> bool {
    match command {
        TraceCommand::SpawnDesktop {
            launcher,
            launch,
            response,
        } => {
            let _ = response.send(spawn_desktop(launcher, launch));
            false
        }
        TraceCommand::SpawnTerminal {
            launcher,
            launch,
            cols,
            rows,
            response,
        } => {
            let _ = response.send(spawn_terminal(launcher, launch, cols, rows));
            false
        }
        TraceCommand::Register {
            pid,
            identity,
            execs_until_running,
            ready,
        } => {
            if state.identities.insert(pid, identity).is_some() {
                let _ = ready.send(Err(format!(
                    "application PID {pid} is already registered with SocksCap"
                )));
            } else {
                if let Ok(mut lifecycles) = state.launch_lifecycles.lock() {
                    lifecycles.insert(pid, LaunchLifecycle::new(execs_until_running));
                }
                state.launch_ready.insert(pid, ready);
            }
            false
        }
        TraceCommand::Shutdown => true,
    }
}

pub(super) fn spawn_desktop(launcher: PathBuf, launch: LaunchCommand) -> Result<u32, String> {
    let mut command = Command::new(&launcher);
    command.arg(&launch.executable);
    command.args(&launch.args);
    command.envs(launch.environment);
    if let Some(directory) = &launch.working_directory {
        command.current_dir(directory);
    }
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().map_err(|error| {
        format!(
            "launch {} through SocksCap: {error}",
            launch.executable.display()
        )
    })?;
    let pid = child.id();
    drop(child);
    Ok(pid)
}

pub(super) fn spawn_terminal(
    launcher: PathBuf,
    launch: LaunchCommand,
    cols: u16,
    rows: u16,
) -> Result<SpawnedTerminal, String> {
    let launcher = launcher.to_string_lossy().into_owned();
    let executable = launch.executable.to_string_lossy().into_owned();
    let mut launcher_args = Vec::with_capacity(launch.args.len() + 1);
    launcher_args.push(executable);
    launcher_args.extend(launch.args);
    let (handle, reader) = crate::terminal::pty::create_command_pty_with_launch_options(
        cols,
        rows,
        &launcher,
        &launcher_args,
        launch
            .working_directory
            .map(|path| path.to_string_lossy().into_owned()),
        &launch.environment,
    )?;
    let pid = handle
        .child
        .process_id()
        .ok_or_else(|| "terminal application exited before its PID was available".to_string())?;
    Ok((pid, handle, reader))
}

pub(super) fn handle_wait_status(
    pid: libc::pid_t,
    status: libc::c_int,
    state: &mut TraceState,
    flows: &FlowQueue,
    relay_port: u16,
    ipv6_ready: bool,
) {
    if libc::WIFEXITED(status) {
        let code = libc::WEXITSTATUS(status);
        state.remove(
            pid,
            &format!("application PID {pid} exited with status {code} before the target started"),
        );
        return;
    }
    if libc::WIFSIGNALED(status) {
        let signal = libc::WTERMSIG(status);
        state.remove(
            pid,
            &format!(
                "application PID {pid} was terminated by signal {signal} before the target started"
            ),
        );
        return;
    }
    if !libc::WIFSTOPPED(status) {
        return;
    }

    let signal = libc::WSTOPSIG(status);
    let event = status >> 16;
    if !state.initialized.contains(&pid) {
        match initialize_tracee(pid) {
            Ok(()) => {
                state.initialized.insert(pid);
                if let Some(ready) = state.launch_ready.remove(&pid) {
                    let _ = ready.send(Ok(()));
                }
                if let Err(error) = ptrace_resume(pid, libc::PTRACE_CONT, 0) {
                    tracing::warn!(pid, "resume newly traced application: {error}");
                }
            }
            Err(error) => {
                if let Some(ready) = state.launch_ready.remove(&pid) {
                    let _ = ready.send(Err(error.clone()));
                }
                tracing::warn!(pid, "initialize rootless trace: {error}");
                kill_tracee(pid);
            }
        }
        return;
    }

    if event == libc::PTRACE_EVENT_SECCOMP {
        let registers = match syscall_registers(pid) {
            Ok(registers) => registers,
            Err(error) => {
                tracing::warn!(pid, "read seccomp syscall: {error}");
                kill_tracee(pid);
                return;
            }
        };
        if registers.number() == libc::SYS_socket {
            if let Err(error) = handle_socket(pid, &registers, &mut state.socket_types) {
                tracing::warn!(pid, "observe rootless socket syscall: {error}");
                kill_tracee(pid);
            }
            return;
        }
        let Some(identity) = state.identities.get(&pid).cloned() else {
            kill_tracee(pid);
            return;
        };
        if let Err(error) = handle_connect(
            pid,
            &identity,
            &state.socket_types,
            flows,
            relay_port,
            ipv6_ready,
        ) {
            tracing::warn!(pid, "capture rootless connect syscall: {error}");
            kill_tracee(pid);
        }
        return;
    }

    if matches!(
        event,
        libc::PTRACE_EVENT_FORK | libc::PTRACE_EVENT_VFORK | libc::PTRACE_EVENT_CLONE
    ) {
        match ptrace_event_pid(pid) {
            Ok(child) => {
                if let Some(identity) = state.identities.get(&pid).cloned() {
                    state.identities.insert(child, identity);
                    state.initialized.insert(child);
                }
            }
            Err(error) => tracing::warn!(pid, "read traced child PID: {error}"),
        }
        let _ = ptrace_resume(pid, libc::PTRACE_CONT, 0);
        return;
    }

    if event == libc::PTRACE_EVENT_EXEC {
        state.observe_exec(pid);
        let _ = ptrace_resume(pid, libc::PTRACE_CONT, 0);
        return;
    }

    if event != 0 || signal == libc::SIGTRAP {
        let _ = ptrace_resume(pid, libc::PTRACE_CONT, 0);
        return;
    }

    // Automatically attached children first report SIGSTOP. Other signals are
    // real signal-delivery stops and must remain visible to the application.
    let delivered_signal = if signal == libc::SIGSTOP { 0 } else { signal };
    let _ = ptrace_resume(pid, libc::PTRACE_CONT, delivered_signal);
}

pub(super) fn initialize_tracee(pid: libc::pid_t) -> Result<(), String> {
    let options = libc::PTRACE_O_EXITKILL
        | libc::PTRACE_O_TRACESYSGOOD
        | libc::PTRACE_O_TRACEFORK
        | libc::PTRACE_O_TRACEVFORK
        | libc::PTRACE_O_TRACECLONE
        | libc::PTRACE_O_TRACEEXEC
        | libc::PTRACE_O_TRACESECCOMP;
    ptrace_call(
        libc::PTRACE_SETOPTIONS,
        pid,
        std::ptr::null_mut(),
        options as usize as *mut libc::c_void,
    )
    .map(|_| ())
    .map_err(|error| format!("configure ptrace options for PID {pid}: {error}"))
}

pub(super) fn ptrace_event_pid(pid: libc::pid_t) -> Result<libc::pid_t, String> {
    let mut child: libc::c_ulong = 0;
    ptrace_call(
        libc::PTRACE_GETEVENTMSG,
        pid,
        std::ptr::null_mut(),
        (&mut child as *mut libc::c_ulong).cast(),
    )
    .map_err(|error| format!("PTRACE_GETEVENTMSG: {error}"))?;
    Ok(child as libc::pid_t)
}
