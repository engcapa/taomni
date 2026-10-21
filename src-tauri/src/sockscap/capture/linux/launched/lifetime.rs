use super::ingress::start_redirect_ingress;
use super::model::LaunchedAppInfo;
use super::model::LaunchedAppPhase;
use super::model::LaunchedProcess;
use super::model::TerminalActivityReader;
use super::preparation::materialize_launcher;
use super::preparation::preflight;
use super::preparation::prepare_launch;
use super::process_groups::kill_process_group;
use super::process_groups::process_group_is_alive;
use super::process_groups::stop_process_group;
use crate::sockscap::capture::linux::tracer::FlowQueue;
use crate::sockscap::capture::linux::tracer::LaunchStatus;
use crate::sockscap::capture::linux::tracer::ProcessIdentity;
use crate::sockscap::capture::linux::tracer::TracerSupervisor;
use crate::sockscap::config::AppLaunchPreparation;
use crate::sockscap::relay::RelayContext;
use crate::sockscap::relay::RelayHandle;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tokio::sync::RwLock;

/// Lifecycle for the launch-only backend. It owns no system network state, so
/// stop can always return to Idle after closing its children and listener.
pub struct LaunchedCaptureHandle {
    pub(super) relay: Option<RelayHandle>,
    pub(super) relay_port: u16,
    pub(super) launcher_path: PathBuf,
    pub(super) processes: Vec<LaunchedProcess>,
    pub(super) tracer: Option<TracerSupervisor>,
}

impl LaunchedCaptureHandle {
    pub async fn start(ctx: Arc<RwLock<RelayContext>>, runtime_dir: &Path) -> Result<Self, String> {
        let launcher_path = materialize_launcher(runtime_dir)?;
        super::super::tracer::preflight(&launcher_path).map_err(|error| {
            format!("Linux rootless application capture is unavailable: {error}")
        })?;
        let flows = Arc::new(FlowQueue::default());
        let (relay, ipv6_ready) = start_redirect_ingress(ctx, Arc::clone(&flows)).await?;
        let relay_port = relay.port;
        let tracer = match TracerSupervisor::start(relay_port, ipv6_ready, flows) {
            Ok(tracer) => tracer,
            Err(error) => {
                relay.stop().await;
                return Err(error);
            }
        };
        Ok(Self {
            relay: Some(relay),
            relay_port,
            launcher_path,
            processes: Vec::new(),
            tracer: Some(tracer),
        })
    }

    pub fn relay_port(&self) -> u16 {
        self.relay_port
    }

    pub async fn launch_app(
        &mut self,
        profile_id: &str,
        command_name: &str,
        args: &[String],
        launch_preparation: &AppLaunchPreparation,
    ) -> Result<LaunchedAppInfo, String> {
        let command_name = command_name.trim();
        let launch = prepare_launch(command_name, args, launch_preparation)?;
        let executable_text = command_name.to_string();
        let pid = self
            .tracer
            .as_ref()
            .ok_or_else(|| "SocksCap ptrace supervisor is not running".to_string())?
            .spawn_desktop(&self.launcher_path, &launch)?;
        if let Err(error) = self.register_trace(
            pid,
            profile_id,
            &executable_text,
            !launch_preparation.is_empty(),
        ) {
            kill_process_group(pid as libc::pid_t);
            return Err(error);
        }

        let info = LaunchedAppInfo {
            pid,
            profile_id: profile_id.to_string(),
            path: command_name.to_string(),
            args: args.to_vec(),
            launch_preparation: launch_preparation.clone(),
            phase: LaunchedAppPhase::Preparing,
            launch_error: None,
            running: true,
            terminal_session_id: None,
        };
        tracing::info!(
            pid,
            command = command_name,
            executable = command_name,
            argument_count = args.len(),
            prepared = !launch_preparation.is_empty(),
            "SocksCap launched application under ptrace/seccomp capture"
        );
        self.processes.push(LaunchedProcess {
            info: info.clone(),
            process_group: pid as libc::pid_t,
            terminal_running: None,
        });
        Ok(info)
    }

    pub fn launch_terminal_app(
        &mut self,
        profile_id: &str,
        command_name: &str,
        args: &[String],
        launch_preparation: &AppLaunchPreparation,
        terminal_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<
        (
            LaunchedAppInfo,
            crate::terminal::pty::PtyHandle,
            Box<dyn Read + Send>,
        ),
        String,
    > {
        let command_name = command_name.trim();
        let launch = prepare_launch(command_name, args, launch_preparation)?;
        let executable_text = command_name.to_string();
        let (pid, mut handle, reader) = self
            .tracer
            .as_ref()
            .ok_or_else(|| "SocksCap ptrace supervisor is not running".to_string())?
            .spawn_terminal(&self.launcher_path, &launch, cols, rows)?;
        if let Err(error) = self.register_trace(
            pid,
            profile_id,
            &executable_text,
            !launch_preparation.is_empty(),
        ) {
            let _ = handle.child.kill();
            return Err(error);
        }

        let info = LaunchedAppInfo {
            pid,
            profile_id: profile_id.to_string(),
            path: command_name.to_string(),
            args: args.to_vec(),
            launch_preparation: launch_preparation.clone(),
            phase: LaunchedAppPhase::Preparing,
            launch_error: None,
            running: true,
            terminal_session_id: Some(terminal_session_id.to_string()),
        };
        tracing::info!(
            pid,
            command = command_name,
            executable = command_name,
            argument_count = args.len(),
            prepared = !launch_preparation.is_empty(),
            terminal_session_id,
            "SocksCap launched terminal application under ptrace/seccomp capture"
        );
        let terminal_running = Arc::new(AtomicBool::new(true));
        let tracked_reader: Box<dyn Read + Send> = Box::new(TerminalActivityReader {
            inner: reader,
            running: Arc::clone(&terminal_running),
        });
        self.processes.push(LaunchedProcess {
            info: info.clone(),
            process_group: pid as libc::pid_t,
            terminal_running: Some(terminal_running),
        });
        Ok((info, handle, tracked_reader))
    }

    pub(super) fn register_trace(
        &self,
        pid: u32,
        profile_id: &str,
        executable: &str,
        prepared: bool,
    ) -> Result<(), String> {
        self.tracer
            .as_ref()
            .ok_or_else(|| "SocksCap ptrace supervisor is not running".to_string())?
            .register_root(
                pid,
                ProcessIdentity {
                    profile_id: profile_id.to_string(),
                    configured_path: executable.to_string(),
                },
                if prepared { 2 } else { 1 },
            )
            .map_err(|error| format!("attach rootless capture to PID {pid}: {error}"))
    }

    pub fn apps(&mut self) -> Vec<LaunchedAppInfo> {
        for process in &mut self.processes {
            if process.info.running {
                if let Some(status) = self
                    .tracer
                    .as_ref()
                    .and_then(|tracer| tracer.launch_status(process.info.pid))
                {
                    match status {
                        LaunchStatus::Preparing => {
                            process.info.phase = LaunchedAppPhase::Preparing;
                            process.info.launch_error = None;
                        }
                        LaunchStatus::Running => {
                            process.info.phase = LaunchedAppPhase::Running;
                            process.info.launch_error = None;
                        }
                        LaunchStatus::Exited => {
                            process.info.phase = LaunchedAppPhase::Exited;
                            process.info.launch_error = None;
                            process.info.running = false;
                            continue;
                        }
                        LaunchStatus::Failed(error) => {
                            process.info.phase = LaunchedAppPhase::Failed;
                            process.info.launch_error = Some(error);
                            process.info.running = false;
                            continue;
                        }
                    }
                }
                if process
                    .terminal_running
                    .as_ref()
                    .is_some_and(|running| !running.load(Ordering::Acquire))
                {
                    process.info.phase = LaunchedAppPhase::Exited;
                    process.info.running = false;
                    continue;
                }
                process.info.running = process_group_is_alive(process.process_group);
                if !process.info.running {
                    process.info.phase = LaunchedAppPhase::Exited;
                }
            }
        }
        self.processes
            .iter()
            .map(|process| process.info.clone())
            .collect()
    }

    pub async fn stop_app(&mut self, pid: u32) -> Result<(), String> {
        let process = self
            .processes
            .iter_mut()
            .find(|process| process.info.pid == pid)
            .ok_or_else(|| format!("no SocksCap-launched application with PID {pid}"))?;
        stop_process_group(process).await
    }

    pub async fn stop(&mut self) {
        for process in &mut self.processes {
            if let Err(error) = stop_process_group(process).await {
                tracing::warn!(pid = process.info.pid, "stop launched app: {error}");
            }
        }
        if let Some(mut tracer) = self.tracer.take() {
            tracer.shutdown();
        }
        if let Some(relay) = self.relay.take() {
            relay.stop().await;
        }
    }
}
