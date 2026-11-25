//! Production host lifecycle. All waits have deadlines and observe an
//! independent cancellation handle; idle supervision uses nonblocking tick.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;
use taomni_plugin_api::{
    CancelRequest, ErrorCode, Heartbeat, RequestId, RequestIdMode, RpcError, RpcMessage,
    RpcRequest, RpcResponse,
};

use super::{
    FrameError, HostState, HostSupervisor, HostSupervisorConfig, JsonLineCodec, RestartAction,
    SupervisorEvent,
};

#[path = "cancellation.rs"]
mod cancellation;
#[path = "execution.rs"]
mod execution;
#[path = "launch.rs"]
mod launch;
#[path = "profile.rs"]
mod profile;
#[path = "pump.rs"]
mod pump;
#[path = "service_requests.rs"]
mod service_requests;
#[path = "snapshot.rs"]
mod snapshot;
#[path = "transport.rs"]
mod transport;

pub use cancellation::HostCancellation;
use cancellation::RequestGuard;
pub use profile::HostProfileConfig;
use pump::PumpOutcome;
pub use service_requests::HostServiceConfig;
use service_requests::service_error;
use taomni_plugin_services::{OperationPermit, ServiceSession};
use transport::Transport;

#[derive(Debug, thiserror::Error)]
pub enum HostProcessError {
    #[error("failed to spawn plugin host: {0}")]
    Spawn(#[source] io::Error),
    #[error("MODULE_HOST_NOEXEC: plugin host {} is on a noexec filesystem. Close Taomni, copy its active data profile to an executable user-owned filesystem, and restart with XDG_DATA_HOME set to that data parent.", .0.display())]
    NoExec(PathBuf),
    #[error("plugin host I/O failed: {0}")]
    Io(#[source] io::Error),
    #[error("plugin host frame failed: {0}")]
    Frame(#[from] FrameError),
    #[error("plugin host RPC failed ({code}): {message}")]
    Rpc { code: i32, message: String },
    #[error("plugin host handshake was rejected: {0}")]
    Handshake(String),
    #[error("plugin host request timed out")]
    Timeout,
    #[error("plugin request cancelled")]
    Cancelled,
    #[error("plugin host exited unexpectedly")]
    Crashed,
    #[error("plugin host returned an unexpected response")]
    UnexpectedResponse,
}

impl HostProcessError {
    pub fn rpc_code(&self) -> i32 {
        match self {
            Self::Rpc { code, .. } => *code,
            Self::Timeout => ErrorCode::RequestTimeout.as_i32(),
            Self::Cancelled => ErrorCode::RequestCancelled.as_i32(),
            Self::NoExec(_) => ErrorCode::PermissionDenied.as_i32(),
            Self::Handshake(_) => ErrorCode::InvalidState.as_i32(),
            Self::Spawn(_) | Self::Io(_) | Self::Crashed => ErrorCode::PluginCrashed.as_i32(),
            Self::Frame(_) | Self::UnexpectedResponse => ErrorCode::InvalidRequest.as_i32(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostTick {
    Healthy,
    Stopped,
    RestartScheduled { attempt: u32, after: Duration },
    RestartReady { attempt: u32 },
    RestartExhausted,
}

#[derive(Debug)]
struct LaunchConfig {
    plugin_id: String,
    plugin_version: String,
    host: PathBuf,
    working_dir: PathBuf,
    commands: Vec<String>,
    permissions: Vec<String>,
    profile: Option<HostProfileConfig>,
}

pub struct HostProcess {
    launch: LaunchConfig,
    transport: Option<Transport>,
    retired_transports: Vec<Transport>,
    supervisor: HostSupervisor,
    cancellation: HostCancellation,
    token: String,
    id_prefix: String,
    next_id: u64,
    started_at: Instant,
    next_heartbeat_ms: u64,
    restart_due: Option<(Instant, u32)>,
    service_config: Option<HostServiceConfig>,
    services: Option<ServiceSession>,
    active_operation: Option<OperationPermit>,
    instance: Option<taomni_plugin_api::services::HostInstanceId>,
    request_id_mode: RequestIdMode,
}

impl std::fmt::Debug for HostProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostProcess")
            .field("launch", &self.launch)
            .field("state", &self.state())
            .field("services", &self.services)
            .finish_non_exhaustive()
    }
}

impl HostProcess {
    pub fn start(
        plugin_id: &str,
        plugin_version: &str,
        host: &Path,
        working_dir: &Path,
        commands: &[String],
        permissions: &[String],
        config: HostSupervisorConfig,
    ) -> Result<Self, HostProcessError> {
        Self::start_with_services(
            plugin_id,
            plugin_version,
            host,
            working_dir,
            commands,
            permissions,
            config,
            None,
        )
    }

    pub fn start_with_services(
        plugin_id: &str,
        plugin_version: &str,
        host: &Path,
        working_dir: &Path,
        commands: &[String],
        permissions: &[String],
        config: HostSupervisorConfig,
        services: Option<HostServiceConfig>,
    ) -> Result<Self, HostProcessError> {
        Self::start_launch(
            LaunchConfig {
                plugin_id: plugin_id.to_owned(),
                plugin_version: plugin_version.to_owned(),
                host: host.to_owned(),
                working_dir: working_dir.to_owned(),
                commands: commands.to_vec(),
                permissions: permissions.to_vec(),
                profile: None,
            },
            config,
            services,
        )
    }

    pub fn start_profiled(
        profile: HostProfileConfig,
        plugin_id: &str,
        plugin_version: &str,
        host: &Path,
        working_dir: &Path,
        commands: &[String],
        permissions: &[String],
        config: HostSupervisorConfig,
        services: Option<HostServiceConfig>,
    ) -> Result<Self, HostProcessError> {
        Self::start_launch(
            LaunchConfig {
                plugin_id: plugin_id.to_owned(),
                plugin_version: plugin_version.to_owned(),
                host: host.to_owned(),
                working_dir: working_dir.to_owned(),
                commands: commands.to_vec(),
                permissions: permissions.to_vec(),
                profile: Some(profile),
            },
            config,
            services,
        )
    }

    fn start_launch(
        launch: LaunchConfig,
        config: HostSupervisorConfig,
        services: Option<HostServiceConfig>,
    ) -> Result<Self, HostProcessError> {
        let mut process = Self {
            supervisor: HostSupervisor::new(&launch.plugin_id, config, 0),
            launch,
            transport: None,
            retired_transports: Vec::new(),
            cancellation: HostCancellation::default(),
            token: String::new(),
            id_prefix: process_token(),
            next_id: 0,
            started_at: Instant::now(),
            next_heartbeat_ms: 0,
            restart_due: None,
            service_config: services,
            services: None,
            active_operation: None,
            instance: None,
            request_id_mode: RequestIdMode::Legacy,
        };
        process.spawn_and_activate()?;
        Ok(process)
    }

    pub fn state(&self) -> HostState {
        self.supervisor.state()
    }

    pub fn cancellation_handle(&self) -> HostCancellation {
        self.cancellation.clone()
    }

    pub fn invoke(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, HostProcessError> {
        let id = self.next_request_id()?;
        self.invoke_until(id, method, params, None)
    }

    pub fn invoke_with_id(
        &mut self,
        id: RequestId,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, HostProcessError> {
        if self.request_id_mode == RequestIdMode::MonotonicV1 {
            let _caller = RequestGuard::new(self.cancellation.clone(), id.clone());
            let wire_id = self.next_request_id()?;
            if !self.cancellation.link(&id, &wire_id) {
                return Err(HostProcessError::UnexpectedResponse);
            }
            self.invoke_until(wire_id, method, params, None)
        } else {
            self.invoke_until(id, method, params, None)
        }
    }

    fn invoke_until(
        &mut self,
        id: RequestId,
        method: &str,
        params: Option<Value>,
        deadline: Option<Instant>,
    ) -> Result<Value, HostProcessError> {
        let _guard = RequestGuard::new(self.cancellation.clone(), id.clone());
        // A cancellation made while waiting for the owning process mutex must
        // not send the queued command or be overwritten by registration.
        if self.cancellation.is_cancelled(&id) {
            return Err(HostProcessError::Cancelled);
        }
        if self.supervisor.state() != HostState::Running || self.transport.is_none() {
            return Err(HostProcessError::Crashed);
        }
        let now_ms = self.elapsed_ms();
        let deadline = deadline
            .or_else(|| {
                self.active_operation
                    .as_ref()
                    .and_then(OperationPermit::deadline)
            })
            .unwrap_or_else(|| Instant::now() + self.supervisor.config().request_timeout);
        let remaining_ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        self.supervisor
            .register_request_until(id.clone(), now_ms.saturating_add(remaining_ms))
            .map_err(|error| HostProcessError::Rpc {
                code: error.code,
                message: error.message,
            })?;
        let mut message = RpcMessage::Request(RpcRequest::new(id.clone(), method, params));
        if let RpcMessage::Request(request) = &mut message {
            request.context = self
                .active_operation
                .as_ref()
                .map(|permit| permit.context().clone());
        }
        let result = self
            .transport
            .as_ref()
            .expect("running host transport")
            .write(&message, deadline, Some((&self.cancellation, &id)))
            .and_then(|()| self.receive_response(&id, deadline, true));
        let response = match result {
            Ok(response) => response,
            Err(error @ (HostProcessError::Cancelled | HostProcessError::Timeout)) => {
                if matches!(error, HostProcessError::Timeout) && self.active_operation.is_some() {
                    // An expired key operation retires its authenticated
                    // transport even if the SDK could acknowledge cancel.
                    // Timer scheduling must not choose whether old key
                    // authority survives the core-owned deadline.
                    self.schedule_restart();
                } else {
                    self.cancel_in_host(&id, &error.to_string());
                }
                return Err(error);
            }
            Err(error) => {
                self.schedule_restart();
                return Err(error);
            }
        };
        if !self.supervisor.complete_response(&response) {
            return Err(HostProcessError::UnexpectedResponse);
        }
        if self.cancellation.is_cancelled(&id) {
            return Err(HostProcessError::Cancelled);
        }
        if let Some(permit) = &self.active_operation {
            if let Err(error) = permit.check_current() {
                self.schedule_restart();
                return Err(service_error(error));
            }
        }
        if let Some(error) = response.error {
            return Err(HostProcessError::Rpc {
                code: error.code,
                message: error.message,
            });
        }
        response.result.ok_or(HostProcessError::UnexpectedResponse)
    }

    /// Drain ready messages, detect exit/liveness failures and send an active
    /// heartbeat. This never waits on a pipe or a response and may run from a
    /// registry monitor using try_lock, including while no command is active.
    pub fn tick(&mut self) -> HostTick {
        match self.supervisor.state() {
            HostState::Stopped | HostState::Stopping => return HostTick::Stopped,
            HostState::RestartExhausted => return HostTick::RestartExhausted,
            _ => {}
        }
        if let Some((due, attempt)) = self.restart_due {
            let after = due.saturating_duration_since(Instant::now());
            return if after.is_zero() {
                HostTick::RestartReady { attempt }
            } else {
                HostTick::RestartScheduled { attempt, after }
            };
        }
        if self.transport.as_mut().is_none_or(Transport::exited) {
            return self.schedule_restart();
        }
        // Bound work per tick even if a host floods stdout.
        for _ in 0..128 {
            match self.pump_one(None, None) {
                Ok(PumpOutcome::Idle) => break,
                Ok(PumpOutcome::Handled) => {}
                Ok(PumpOutcome::Response(_)) | Err(_) => return self.schedule_restart(),
            }
        }
        let now_ms = self.elapsed_ms();
        if self
            .supervisor
            .poll(now_ms)
            .iter()
            .any(|event| matches!(event, SupervisorEvent::HeartbeatTimeout { .. }))
            || self.send_heartbeat().is_err()
        {
            return self.schedule_restart();
        }
        HostTick::Healthy
    }

    /// Spawn after the scheduled backoff. The same supervisor owns the budget
    /// across replacements; failed handshakes consume the next attempt too.
    /// In-flight requests are failed, never replayed against a new process.
    pub fn restart(&mut self) -> Result<(), HostProcessError> {
        if !matches!(self.tick(), HostTick::RestartReady { .. }) {
            return Err(HostProcessError::Rpc {
                code: ErrorCode::InvalidState.as_i32(),
                message: "plugin restart is not due".into(),
            });
        }
        self.confirm_retired(Instant::now() + Duration::from_secs(5))?;
        self.restart_due.take();
        self.supervisor.mark_restarted(self.elapsed_ms());
        if let Err(error) = self.spawn_and_activate() {
            self.schedule_restart();
            return Err(error);
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        self.discard_services();
        self.supervisor.stop();
        self.restart_due.take();
        self.transport.take();
        self.retired_transports.clear();
    }

    pub fn stop_confirmed(&mut self, deadline: Instant) -> Result<(), HostProcessError> {
        self.discard_services();
        self.supervisor.stop();
        self.restart_due.take();
        self.confirm_retired(deadline)?;
        if let Some(transport) = self.transport.as_mut() {
            transport.terminate_confirmed(deadline)?;
        }
        self.transport.take();
        Ok(())
    }

    fn confirm_retired(&mut self, deadline: Instant) -> Result<(), HostProcessError> {
        for transport in &mut self.retired_transports {
            transport.terminate_confirmed(deadline)?;
        }
        self.retired_transports.clear();
        Ok(())
    }

    fn schedule_restart(&mut self) -> HostTick {
        self.discard_services();
        if let Some(mut transport) = self.transport.take() {
            transport.begin_termination();
            self.retired_transports.push(transport);
        }
        if self.restart_due.is_some() || self.supervisor.state() == HostState::RestartExhausted {
            return self.tick();
        }
        let now_ms = self.elapsed_ms();
        match self.supervisor.host_exited(now_ms) {
            RestartAction::Restart { attempt, after } => {
                self.restart_due = Some((Instant::now() + after, attempt));
                HostTick::RestartScheduled { attempt, after }
            }
            RestartAction::Exhausted => HostTick::RestartExhausted,
        }
    }

    fn next_request_id(&mut self) -> Result<RequestId, HostProcessError> {
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| HostProcessError::Rpc {
                code: ErrorCode::InvalidState.as_i32(),
                message: "plugin request sequence exhausted".into(),
            })?;
        if let Some(host) = self.instance.as_ref() {
            return Ok(format!("core/{host}/{}", self.next_id).into());
        }
        Ok(format!("taomni-internal-{}-{}", self.id_prefix, self.next_id).into())
    }

    fn elapsed_ms(&self) -> u64 {
        self.started_at
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn process_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
