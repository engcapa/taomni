//! Unprivileged Linux helper client.
//!
//! The client speaks only the authenticated `HelperRequest` protocol.  It does
//! not expose arbitrary command execution, credentials, or shell text.  The
//! real factory launches the installed helper through the fixed polkit
//! executable and verifies the helper PID/executable digest before accepting
//! the bootstrap key.  Tests can inject a transport without touching host
//! networking.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

use super::helper_protocol::{HelperRequest, HelperResponse, ProtocolError};
use super::linux::{LINUX_ADAPTER_ID, LinuxCapturePlan};
use super::unix_transport::{
    HelperChannel, INSTALLED_HELPER_POLICY, UnixPeerPolicy, connect_verified_channel,
    helper_socket_path, load_installed_policy,
};
use super::{AdapterProbe, CaptureArtifactState, CaptureError, CaptureHandle, CaptureInstallSpec};
use crate::sockscap::types::CapturePlatform;

pub const DEFAULT_PKEXEC_PATH: &str = "/usr/bin/pkexec";
pub const DEFAULT_HELPER_PATH: &str = "/usr/libexec/taomni/sockscap-helper";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const READY_LINE_BYTES: usize = 4096;
const CHILD_STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// Fixed launch inputs installed by the package.  They are not accepted from
/// a WebView or arbitrary profile field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxHelperLaunchConfig {
    pub pkexec_path: PathBuf,
    pub helper_path: PathBuf,
    pub policy_path: PathBuf,
    pub authorized_uid: u32,
    pub expected_app_pid: u32,
}

impl Default for LinuxHelperLaunchConfig {
    fn default() -> Self {
        Self {
            pkexec_path: PathBuf::from(DEFAULT_PKEXEC_PATH),
            helper_path: PathBuf::from(DEFAULT_HELPER_PATH),
            policy_path: PathBuf::from(INSTALLED_HELPER_POLICY),
            authorized_uid: current_uid(),
            expected_app_pid: std::process::id(),
        }
    }
}

impl LinuxHelperLaunchConfig {
    pub fn validate(&self) -> Result<(), LinuxClientError> {
        if self.pkexec_path != Path::new(DEFAULT_PKEXEC_PATH)
            || self.helper_path != Path::new(DEFAULT_HELPER_PATH)
            || self.policy_path != Path::new(INSTALLED_HELPER_POLICY)
        {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_LAUNCH_PATH_INVALID",
                "helper, pkexec, and policy paths must match the installed allowlist",
            ));
        }
        if self.authorized_uid == 0
            || self.authorized_uid == u32::MAX
            || self.authorized_uid != current_uid()
            || self.expected_app_pid == 0
            || self.expected_app_pid != std::process::id()
        {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_LAUNCH_IDENTITY_INVALID",
                "authorized UID and app PID must identify the current unprivileged process",
            ));
        }
        Ok(())
    }
}

/// A typed request/response transport.  The implementation must preserve the
/// helper protocol's sequence/MAC checks; callers never receive a raw socket.
#[async_trait]
pub trait LinuxHelperTransport: Send {
    /// PID obtained from the kernel-verified peer credentials, when the
    /// transport has such an identity. Test transports may return `None`, but
    /// the real Unix transport always supplies it.
    fn verified_peer_pid(&self) -> Option<u32> {
        None
    }

    /// Real Unix transports must prove the peer PID through kernel peer
    /// credentials. Test transports can explicitly opt out so protocol and
    /// lifecycle tests do not need to fabricate an OS socket identity.
    fn requires_verified_peer_pid(&self) -> bool {
        false
    }

    async fn request(
        &mut self,
        request_id: &str,
        generation: u64,
        request: HelperRequest,
    ) -> Result<HelperResponse, LinuxClientError>;

    async fn close(&mut self) -> Result<(), LinuxClientError> {
        Ok(())
    }
}

#[async_trait]
impl LinuxHelperTransport for HelperChannel {
    fn verified_peer_pid(&self) -> Option<u32> {
        Some(self.peer().pid)
    }

    fn requires_verified_peer_pid(&self) -> bool {
        true
    }

    async fn request(
        &mut self,
        request_id: &str,
        generation: u64,
        request: HelperRequest,
    ) -> Result<HelperResponse, LinuxClientError> {
        self.send(request_id.to_string(), generation, request)
            .await
            .map_err(LinuxClientError::Protocol)?;
        let response = self
            .receive::<HelperResponse>()
            .await
            .map_err(LinuxClientError::Protocol)?;
        if response.request_id() != request_id {
            return Err(LinuxClientError::Protocol(ProtocolError::Authentication(
                "helper response request id does not match the request".into(),
            )));
        }
        if response.generation() != generation {
            return Err(LinuxClientError::GenerationMismatch {
                expected: generation,
                actual: response.generation(),
            });
        }
        Ok(response.body().clone())
    }
}

/// Factory abstraction lets unit tests exercise all response and generation
/// handling without launching polkit or mutating routes.
#[async_trait]
pub trait LinuxHelperSessionFactory: Send + Sync {
    async fn connect(
        &self,
        generation: u64,
    ) -> Result<Box<dyn LinuxHelperTransport>, LinuxClientError>;
}

/// Stateful client used by the future Linux `CaptureAdapter`.  A session is
/// single-generation and is dropped on transport/protocol failure; callers
/// must then start recovery rather than reusing a possibly stale channel.
pub struct LinuxHelperClient {
    generation: u64,
    factory: Arc<dyn LinuxHelperSessionFactory>,
    session: Arc<Mutex<LinuxHelperSessionState>>,
    next_request: AtomicU64,
}

#[derive(Default)]
struct LinuxHelperSessionState {
    transport: Option<Box<dyn LinuxHelperTransport>>,
    verified_peer_pid: Option<u32>,
    verified_peer_required: bool,
    recovery_required: bool,
}

impl std::fmt::Debug for LinuxHelperClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LinuxHelperClient")
            .field("generation", &self.generation)
            .field("connected", &"redacted")
            .finish()
    }
}

impl LinuxHelperClient {
    pub fn new(
        generation: u64,
        factory: Arc<dyn LinuxHelperSessionFactory>,
    ) -> Result<Self, LinuxClientError> {
        if generation == 0 {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_GENERATION_INVALID",
                "helper client generation must be non-zero",
            ));
        }
        Ok(Self {
            generation,
            factory,
            session: Arc::new(Mutex::new(LinuxHelperSessionState::default())),
            next_request: AtomicU64::new(1),
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub async fn probe(&self) -> Result<AdapterProbe, LinuxClientError> {
        match self.request(HelperRequest::Probe).await? {
            HelperResponse::Probe { report }
                if report.platform == CapturePlatform::Linux
                    && report.adapter == LINUX_ADAPTER_ID =>
            {
                Ok(report)
            }
            HelperResponse::Probe { .. } => Err(LinuxClientError::invalid(
                "LINUX_HELPER_PROBE_IDENTITY_INVALID",
                "helper probe returned an unexpected Linux adapter identity",
            )),
            _ => Err(LinuxClientError::UnexpectedResponse("probe")),
        }
    }

    pub async fn prepare(
        &self,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, LinuxClientError> {
        self.ensure_spec_generation(spec)?;
        spec.validate().map_err(LinuxClientError::Capture)?;
        match self
            .request(HelperRequest::Prepare { spec: spec.clone() })
            .await?
        {
            HelperResponse::Prepared { handle } => {
                if let Err(error) = self
                    .validate_returned_handle(&handle, spec, "prepare")
                    .await
                {
                    self.mark_recovery_required().await;
                    return Err(self.response_validation_error(error, &handle.artifact));
                }
                Ok(handle)
            }
            _ => Err(LinuxClientError::UnexpectedResponse("prepare")),
        }
    }

    pub async fn activate(
        &self,
        spec: &CaptureInstallSpec,
        runtime_pid: u32,
        runtime_start_token: u64,
    ) -> Result<CaptureHandle, LinuxClientError> {
        self.ensure_spec_generation(spec)?;
        spec.validate().map_err(LinuxClientError::Capture)?;
        if runtime_pid == 0 || runtime_start_token == 0 {
            return Err(LinuxClientError::invalid(
                "LINUX_TUN_RUNTIME_IDENTITY_INVALID",
                "TUN runtime PID and start token must be non-zero",
            ));
        }
        match self
            .request(HelperRequest::Activate {
                generation: self.generation,
                runtime_pid,
                runtime_start_token,
            })
            .await?
        {
            HelperResponse::Installed { handle } => {
                if let Err(error) = self
                    .validate_returned_handle(&handle, spec, "activate")
                    .await
                {
                    self.mark_recovery_required().await;
                    return Err(self.response_validation_error(error, &handle.artifact));
                }
                Ok(handle)
            }
            _ => Err(LinuxClientError::UnexpectedResponse("activate")),
        }
    }

    pub async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, LinuxClientError> {
        self.ensure_spec_generation(spec)?;
        self.validate_handle_identity(handle, "update")?;
        spec.validate().map_err(LinuxClientError::Capture)?;
        match self
            .request(HelperRequest::Update {
                handle: handle.clone(),
                spec: spec.clone(),
            })
            .await?
        {
            HelperResponse::Updated { handle } => {
                if let Err(error) = self.validate_returned_handle(&handle, spec, "update").await {
                    self.mark_recovery_required().await;
                    return Err(self.response_validation_error(error, &handle.artifact));
                }
                Ok(handle)
            }
            _ => Err(LinuxClientError::UnexpectedResponse("update")),
        }
    }

    pub async fn heartbeat(
        &self,
        handle: &CaptureHandle,
    ) -> Result<CaptureHandle, LinuxClientError> {
        self.validate_handle_identity(handle, "heartbeat")?;
        match self
            .request(HelperRequest::Heartbeat {
                generation: self.generation,
            })
            .await?
        {
            HelperResponse::Heartbeat {
                helper_pid,
                generation,
                artifact: Some(artifact),
            } if generation == self.generation && helper_pid != 0 => {
                if let Err(error) = self
                    .validate_heartbeat_artifact(handle, helper_pid, &artifact)
                    .await
                {
                    self.mark_recovery_required().await;
                    return Err(self.response_validation_error(error, &artifact));
                }
                if artifact.generation != self.generation
                    || artifact.adapter != handle.artifact.adapter
                    || artifact.owner_uid != handle.artifact.owner_uid
                    || artifact.interface_names != handle.artifact.interface_names
                    || artifact.rule_ids != handle.artifact.rule_ids
                    || artifact.route_ids != handle.artifact.route_ids
                    || artifact.cgroup_paths != handle.artifact.cgroup_paths
                    || artifact.driver_service != handle.artifact.driver_service
                    || artifact.extension_bundle_id != handle.artifact.extension_bundle_id
                {
                    let error = LinuxClientError::invalid(
                        "LINUX_HELPER_HEARTBEAT_INVALID",
                        "helper heartbeat changed immutable capture identity",
                    );
                    self.mark_recovery_required().await;
                    return Err(self.response_validation_error(error, &artifact));
                }
                Ok(CaptureHandle {
                    generation,
                    config_revision: handle.config_revision,
                    helper_pid,
                    artifact,
                })
            }
            HelperResponse::Heartbeat { .. } => {
                let error = LinuxClientError::invalid(
                    "LINUX_HELPER_HEARTBEAT_INVALID",
                    "helper heartbeat omitted a valid generation, PID, or artifact",
                );
                self.mark_recovery_required().await;
                Err(self.response_validation_error(error, &handle.artifact))
            }
            _ => Err(LinuxClientError::UnexpectedResponse("heartbeat")),
        }
    }

    pub async fn stop(&self, handle: &CaptureHandle) -> Result<(), LinuxClientError> {
        self.validate_handle_identity(handle, "stop")?;
        match self
            .request(HelperRequest::Stop {
                handle: handle.clone(),
            })
            .await?
        {
            HelperResponse::Stopped => {
                // The request itself establishes the authenticated peer when
                // this client was reconstructed after an app restart. Only
                // check the handle PID after that channel exists.
                if let Err(error) = self.validate_helper_pid(handle.helper_pid).await {
                    self.mark_recovery_required().await;
                    return Err(self.response_validation_error(error, &handle.artifact));
                }
                Ok(())
            }
            _ => Err(LinuxClientError::UnexpectedResponse("stop")),
        }
    }

    fn validate_handle_identity(
        &self,
        handle: &CaptureHandle,
        operation: &'static str,
    ) -> Result<(), LinuxClientError> {
        if handle.generation != self.generation
            || handle.artifact.generation != self.generation
            || handle.helper_pid == 0
            || handle.config_revision == 0
        {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_HANDLE_GENERATION_INVALID",
                "capture handle belongs to another helper generation or has empty identity",
            ));
        }
        self.validate_linux_artifact(&handle.artifact, operation)
    }

    fn validate_linux_artifact(
        &self,
        artifact: &CaptureArtifactState,
        operation: &'static str,
    ) -> Result<(), LinuxClientError> {
        artifact.validate().map_err(|error| {
            LinuxClientError::Capture(CaptureError {
                code: error.code,
                message: format!(
                    "{operation} rejected an invalid capture artifact: {}",
                    error.message
                ),
                recovery_required: error.recovery_required,
                artifact: error.artifact,
            })
        })?;
        let uid = current_uid();
        if uid == 0 || artifact.adapter != LINUX_ADAPTER_ID || artifact.owner_uid != Some(uid) {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_ARTIFACT_IDENTITY_INVALID",
                "Linux capture artifact must use the fixed adapter and current non-root owner",
            ));
        }
        LinuxCapturePlan::from_artifact(artifact)
            .map_err(LinuxClientError::Capture)
            .map(|_| ())
    }

    async fn validate_helper_pid(&self, helper_pid: u32) -> Result<(), LinuxClientError> {
        let state = self.session.lock().await;
        match state.verified_peer_pid {
            Some(expected) if expected == helper_pid => Ok(()),
            Some(_) => Err(LinuxClientError::invalid(
                "LINUX_HELPER_PID_MISMATCH",
                "capture handle helper PID does not match the authenticated helper peer",
            )),
            None if !state.verified_peer_required => Ok(()),
            None => Err(LinuxClientError::invalid(
                "LINUX_HELPER_PEER_UNVERIFIED",
                "capture handle has no kernel-verified helper peer identity",
            )),
        }
    }

    async fn validate_returned_handle(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
        operation: &'static str,
    ) -> Result<(), LinuxClientError> {
        handle
            .validate_for(spec)
            .map_err(LinuxClientError::Capture)?;
        self.validate_handle_identity(handle, operation)?;
        self.validate_helper_pid(handle.helper_pid).await
    }

    async fn validate_heartbeat_artifact(
        &self,
        previous: &CaptureHandle,
        helper_pid: u32,
        artifact: &CaptureArtifactState,
    ) -> Result<(), LinuxClientError> {
        self.validate_linux_artifact(artifact, "heartbeat")?;
        self.validate_helper_pid(helper_pid).await?;
        if helper_pid != previous.helper_pid {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_PID_MISMATCH",
                "heartbeat helper PID changed during an active capture",
            ));
        }
        Ok(())
    }

    async fn mark_recovery_required(&self) {
        let mut state = self.session.lock().await;
        state.recovery_required = true;
    }

    fn response_validation_error(
        &self,
        error: LinuxClientError,
        artifact: &CaptureArtifactState,
    ) -> LinuxClientError {
        match error {
            LinuxClientError::Capture(mut capture) => {
                capture.recovery_required = true;
                if capture.artifact.is_none() {
                    capture.artifact = Some(artifact.clone());
                }
                LinuxClientError::Capture(capture)
            }
            LinuxClientError::Invalid { code, message } => LinuxClientError::Capture(
                CaptureError::recovery_with_artifact(code, message, artifact.clone()),
            ),
            other => LinuxClientError::Capture(CaptureError::recovery_with_artifact(
                "LINUX_HELPER_RESPONSE_INVALID",
                other.to_string(),
                artifact.clone(),
            )),
        }
    }

    pub async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), LinuxClientError> {
        if artifact.generation != self.generation {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_ARTIFACT_GENERATION_INVALID",
                "recovery artifact belongs to another helper generation",
            ));
        }
        self.validate_linux_artifact(artifact, "recover")?;
        match self
            .request(HelperRequest::Recover {
                artifact: artifact.clone(),
            })
            .await?
        {
            HelperResponse::Recovered => Ok(()),
            _ => Err(LinuxClientError::UnexpectedResponse("recover")),
        }
    }

    /// Recover a generation using only the root helper receipt. This is the
    /// crash window where the app journal has not received a valid artifact.
    pub async fn recover_generation(&self) -> Result<(), LinuxClientError> {
        match self
            .request(HelperRequest::RecoverGeneration {
                generation: self.generation,
            })
            .await?
        {
            HelperResponse::Recovered => Ok(()),
            _ => Err(LinuxClientError::UnexpectedResponse("recover_generation")),
        }
    }

    pub async fn shutdown(&self) -> Result<(), LinuxClientError> {
        match self.request(HelperRequest::Shutdown).await? {
            HelperResponse::Shutdown => Ok(()),
            _ => Err(LinuxClientError::UnexpectedResponse("shutdown")),
        }
    }

    async fn request(&self, request: HelperRequest) -> Result<HelperResponse, LinuxClientError> {
        let request_id = self.next_request_id()?;
        let operation = request_operation(&request);
        let may_mutate = request_may_mutate(&request);
        let allowed_during_recovery = request_allowed_during_recovery(&request);
        let factory = Arc::clone(&self.factory);
        let session = Arc::clone(&self.session);
        let generation = self.generation;
        let task = tokio::spawn(async move {
            let mut guard = session.lock().await;
            if guard.recovery_required && !allowed_during_recovery {
                return Err(LinuxClientError::RecoveryRequired { operation });
            }
            if guard.transport.is_none() {
                let transport = match factory.connect(generation).await {
                    Ok(transport) => transport,
                    Err(error) => {
                        // A failed reconnect during a mutating operation is
                        // ambiguous: the helper may have accepted the
                        // request before the channel failed. Do not let the
                        // next call start another mutation on that generation.
                        if may_mutate {
                            guard.recovery_required = true;
                            return Err(LinuxClientError::StateUncertain {
                                operation,
                                source: Box::new(error),
                            });
                        }
                        return Err(error);
                    }
                };
                let verified_peer_pid = transport.verified_peer_pid();
                let verified_peer_required = transport.requires_verified_peer_pid();
                if verified_peer_pid == Some(0) {
                    return Err(LinuxClientError::invalid(
                        "LINUX_HELPER_PEER_PID_INVALID",
                        "verified helper peer returned an empty PID",
                    ));
                }
                if verified_peer_required && verified_peer_pid.is_none() {
                    return Err(LinuxClientError::invalid(
                        "LINUX_HELPER_PEER_UNVERIFIED",
                        "real helper transport did not expose kernel-verified peer identity",
                    ));
                }
                guard.verified_peer_pid = verified_peer_pid;
                guard.verified_peer_required = verified_peer_required;
                guard.transport = Some(transport);
            }
            let transport_result = {
                let transport = guard
                    .transport
                    .as_mut()
                    .expect("helper transport inserted above");
                timeout(
                    REQUEST_TIMEOUT,
                    transport.request(&request_id, generation, request),
                )
                .await
                .map_err(|_| LinuxClientError::timeout("LINUX_HELPER_REQUEST_TIMEOUT"))
            };
            let mut result = match transport_result {
                Ok(result) => result.and_then(response_to_result).and_then(|response| {
                    if response_matches_operation(operation, &response) {
                        Ok(response)
                    } else {
                        Err(LinuxClientError::UnexpectedResponse(operation))
                    }
                }),
                Err(error) => Err(error),
            };

            if matches!(
                &result,
                Err(LinuxClientError::Remote {
                    recovery_required: true,
                    ..
                })
            ) {
                guard.recovery_required = true;
            }
            let invalidates = result
                .as_ref()
                .is_err_and(LinuxClientError::invalidates_session);
            if invalidates && may_mutate {
                guard.recovery_required = true;
                if let Err(error) = result {
                    result = Err(LinuxClientError::StateUncertain {
                        operation,
                        source: Box::new(error),
                    });
                }
            }
            let close_session = operation == "shutdown" || invalidates;
            let mut stale = if close_session {
                guard.verified_peer_pid = None;
                guard.verified_peer_required = false;
                guard.transport.take()
            } else {
                None
            };
            drop(guard);

            if let Some(transport) = stale.as_mut() {
                let close_result = transport.close().await;
                if operation == "shutdown" && result.is_ok() {
                    if let Err(error) = close_result {
                        return Err(error);
                    }
                }
            }

            if result.is_ok() && matches!(operation, "recover" | "recover_generation" | "stop") {
                let mut state = session.lock().await;
                state.recovery_required = false;
            }
            result
        });
        task.await.map_err(|_| {
            LinuxClientError::invalid(
                "LINUX_HELPER_REQUEST_TASK_FAILED",
                "helper request task terminated unexpectedly",
            )
        })?
    }

    fn next_request_id(&self) -> Result<String, LinuxClientError> {
        let sequence = self
            .next_request
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| {
                LinuxClientError::invalid(
                    "LINUX_HELPER_REQUEST_ID_EXHAUSTED",
                    "helper request id counter exhausted",
                )
            })?;
        Ok(format!("sockscap-{sequence}"))
    }

    fn ensure_spec_generation(&self, spec: &CaptureInstallSpec) -> Result<(), LinuxClientError> {
        if spec.generation != self.generation {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_SPEC_GENERATION_INVALID",
                "capture specification belongs to another helper generation",
            ));
        }
        if spec.platform != CapturePlatform::Linux {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_PLATFORM_INVALID",
                "Linux helper client accepts only Linux specifications",
            ));
        }
        Ok(())
    }
}

/// Real polkit-backed session factory.  The helper's stdout readiness line is
/// treated as untrusted input and must equal the deterministic socket path.
#[derive(Debug, Clone)]
pub struct RealLinuxHelperSessionFactory {
    pub launch: LinuxHelperLaunchConfig,
}

impl RealLinuxHelperSessionFactory {
    pub fn new(launch: LinuxHelperLaunchConfig) -> Result<Self, LinuxClientError> {
        launch.validate()?;
        Ok(Self { launch })
    }
}

#[async_trait]
impl LinuxHelperSessionFactory for RealLinuxHelperSessionFactory {
    async fn connect(
        &self,
        generation: u64,
    ) -> Result<Box<dyn LinuxHelperTransport>, LinuxClientError> {
        self.launch.validate()?;
        if generation == 0 {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_GENERATION_INVALID",
                "helper generation must be non-zero",
            ));
        }
        let policy = load_installed_policy(&self.launch.policy_path, 0)
            .map_err(LinuxClientError::Protocol)?;
        let socket_path = helper_socket_path(self.launch.authorized_uid, generation);
        let mut child = Command::new(&self.launch.pkexec_path)
            .arg(&self.launch.helper_path)
            .arg("--serve")
            .arg("--authorized-uid")
            .arg(self.launch.authorized_uid.to_string())
            .arg("--expected-pid")
            .arg(self.launch.expected_app_pid.to_string())
            .arg("--generation")
            .arg(generation.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| LinuxClientError::io("LINUX_HELPER_SPAWN_FAILED", error))?;
        let result: Result<HelperChannel, LinuxClientError> = async {
            let pid = child.id().ok_or_else(|| {
                LinuxClientError::invalid(
                    "LINUX_HELPER_PID_INVALID",
                    "spawned helper did not expose a process id",
                )
            })?;
            let stdout = child.stdout.take().ok_or_else(|| {
                LinuxClientError::invalid(
                    "LINUX_HELPER_STDOUT_INVALID",
                    "spawned helper did not expose its readiness pipe",
                )
            })?;
            let mut stdout = BufReader::new(stdout);
            let ready = timeout(READY_TIMEOUT, read_ready_line(&mut stdout))
                .await
                .map_err(|_| LinuxClientError::timeout("LINUX_HELPER_READY_TIMEOUT"))??;
            let expected_ready = format!("SOCKSCAP_HELPER_READY {}", socket_path.display());
            if ready != expected_ready {
                return Err(LinuxClientError::invalid(
                    "LINUX_HELPER_READY_INVALID",
                    "helper readiness path is not the deterministic runtime socket",
                ));
            }
            let stream = timeout(
                Duration::from_secs(5),
                tokio::net::UnixStream::connect(&socket_path),
            )
            .await
            .map_err(|_| LinuxClientError::timeout("LINUX_HELPER_CONNECT_TIMEOUT"))?
            .map_err(|error| LinuxClientError::io("LINUX_HELPER_CONNECT_FAILED", error))?;
            let peer_policy = UnixPeerPolicy {
                expected_pid: Some(pid),
                caller: policy.helper_policy(),
            };
            timeout(
                HANDSHAKE_TIMEOUT,
                connect_verified_channel(stream, &peer_policy),
            )
            .await
            .map_err(|_| LinuxClientError::timeout("LINUX_HELPER_HANDSHAKE_TIMEOUT"))?
            .map_err(LinuxClientError::Protocol)
        }
        .await;
        match result {
            Ok(channel) => Ok(Box::new(RealLinuxHelperTransport {
                channel: Some(channel),
                child,
            })),
            Err(error) => {
                cleanup_failed_helper(&mut child).await;
                Err(error)
            }
        }
    }
}

/// Ensure a helper that failed before the authenticated transport existed is
/// reaped within a bounded window. `kill_on_drop` remains a final fallback,
/// but an explicit wait closes the stale socket/receipt race on launch errors.
async fn cleanup_failed_helper(child: &mut Child) {
    match child.try_wait() {
        Ok(Some(_)) => return,
        Ok(None) | Err(_) => {}
    }
    let _ = child.start_kill();
    let _ = timeout(CHILD_STOP_TIMEOUT, child.wait()).await;
}

struct RealLinuxHelperTransport {
    channel: Option<HelperChannel>,
    child: Child,
}

#[async_trait]
impl LinuxHelperTransport for RealLinuxHelperTransport {
    fn verified_peer_pid(&self) -> Option<u32> {
        self.channel.as_ref().map(|channel| channel.peer().pid)
    }

    fn requires_verified_peer_pid(&self) -> bool {
        true
    }

    async fn request(
        &mut self,
        request_id: &str,
        generation: u64,
        request: HelperRequest,
    ) -> Result<HelperResponse, LinuxClientError> {
        let channel = self.channel.as_mut().ok_or_else(|| {
            LinuxClientError::invalid(
                "LINUX_HELPER_CHANNEL_CLOSED",
                "helper channel has already been closed",
            )
        })?;
        channel.request(request_id, generation, request).await
    }

    async fn close(&mut self) -> Result<(), LinuxClientError> {
        // Dropping the authenticated stream first lets the helper leave its
        // receive loop and run its deterministic cleanup before we consider a
        // kill.  This is important for the root-owned socket guard/receipt.
        self.channel.take();
        match timeout(CHILD_STOP_TIMEOUT, self.child.wait()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(_status)) => Err(LinuxClientError::invalid(
                "LINUX_HELPER_EXIT_FAILED",
                "helper exited without a successful cleanup status",
            )),
            Ok(Err(error)) => Err(LinuxClientError::io("LINUX_HELPER_WAIT_FAILED", error)),
            Err(_) => {
                self.child
                    .start_kill()
                    .map_err(|error| LinuxClientError::io("LINUX_HELPER_KILL_FAILED", error))?;
                timeout(CHILD_STOP_TIMEOUT, self.child.wait())
                    .await
                    .map_err(|_| LinuxClientError::timeout("LINUX_HELPER_STOP_TIMEOUT"))?
                    .map_err(|error| LinuxClientError::io("LINUX_HELPER_WAIT_FAILED", error))?;
                Err(LinuxClientError::timeout("LINUX_HELPER_STOP_TIMEOUT"))
            }
        }
    }
}

async fn read_ready_line<R>(reader: &mut R) -> Result<String, LinuxClientError>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(128);
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|error| LinuxClientError::io("LINUX_HELPER_READY_READ_FAILED", error))?;
        if available.is_empty() {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_READY_MISSING",
                "helper exited before publishing a complete readiness line",
            ));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map(|index| index + 1).unwrap_or(available.len());
        let content = newline.unwrap_or(available.len());
        if line.len().saturating_add(content) > READY_LINE_BYTES {
            return Err(LinuxClientError::invalid(
                "LINUX_HELPER_READY_INVALID",
                "helper readiness line exceeds its bound",
            ));
        }
        line.extend_from_slice(&available[..content]);
        reader.consume(take);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return String::from_utf8(line).map_err(|_| {
                LinuxClientError::invalid(
                    "LINUX_HELPER_READY_INVALID",
                    "helper readiness line is not valid UTF-8",
                )
            });
        }
    }
}

fn response_to_result(response: HelperResponse) -> Result<HelperResponse, LinuxClientError> {
    match response {
        HelperResponse::Error {
            code,
            message,
            recovery_required,
            artifact,
        } => Err(LinuxClientError::Remote {
            code,
            message,
            recovery_required,
            artifact,
        }),
        response => Ok(response),
    }
}

fn request_operation(request: &HelperRequest) -> &'static str {
    match request {
        HelperRequest::Probe => "probe",
        HelperRequest::Prepare { .. } => "prepare",
        HelperRequest::Activate { .. } => "activate",
        HelperRequest::Update { .. } => "update",
        HelperRequest::Stop { .. } => "stop",
        HelperRequest::Recover { .. } => "recover",
        HelperRequest::RecoverGeneration { .. } => "recover_generation",
        HelperRequest::Heartbeat { .. } => "heartbeat",
        HelperRequest::Shutdown => "shutdown",
    }
}

fn request_may_mutate(request: &HelperRequest) -> bool {
    !matches!(request, HelperRequest::Probe)
}

fn request_allowed_during_recovery(request: &HelperRequest) -> bool {
    matches!(
        request,
        HelperRequest::Recover { .. }
            | HelperRequest::RecoverGeneration { .. }
            | HelperRequest::Stop { .. }
            | HelperRequest::Shutdown
    )
}

fn response_matches_operation(operation: &str, response: &HelperResponse) -> bool {
    matches!(
        (operation, response),
        ("probe", HelperResponse::Probe { .. })
            | ("prepare", HelperResponse::Prepared { .. })
            | ("activate", HelperResponse::Installed { .. })
            | ("update", HelperResponse::Updated { .. })
            | ("stop", HelperResponse::Stopped)
            | ("recover", HelperResponse::Recovered)
            | ("recover_generation", HelperResponse::Recovered)
            | ("heartbeat", HelperResponse::Heartbeat { .. })
            | ("shutdown", HelperResponse::Shutdown)
    )
}

#[derive(Debug, thiserror::Error)]
pub enum LinuxClientError {
    #[error("{code}: {message}")]
    Invalid {
        code: &'static str,
        message: &'static str,
    },
    #[error("Linux helper protocol failed: {0}")]
    Protocol(ProtocolError),
    #[error("Linux helper capture operation failed: {0}")]
    Capture(CaptureError),
    #[error("Linux helper returned {code}: {message}")]
    Remote {
        code: String,
        message: String,
        recovery_required: bool,
        artifact: Option<CaptureArtifactState>,
    },
    #[error("Linux helper returned an unexpected response for {0}")]
    UnexpectedResponse(&'static str),
    #[error("Linux helper state is uncertain after {operation}")]
    StateUncertain {
        operation: &'static str,
        source: Box<LinuxClientError>,
    },
    #[error("Linux helper requires recovery before {operation}")]
    RecoveryRequired { operation: &'static str },
    #[error("Linux helper response generation mismatch: expected {expected}, got {actual}")]
    GenerationMismatch { expected: u64, actual: u64 },
    #[error("{code}: {source}")]
    Io {
        code: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("{code}")]
    Timeout { code: &'static str },
}

impl LinuxClientError {
    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::Invalid { code, message }
    }

    fn io(code: &'static str, source: std::io::Error) -> Self {
        Self::Io { code, source }
    }

    fn timeout(code: &'static str) -> Self {
        Self::Timeout { code }
    }

    /// Return the most specific stable error code available.
    ///
    /// Capture/remote errors carry a code supplied by the validated helper
    /// response; collapsing those into a generic transport code makes
    /// recovery telemetry and UI diagnostics lose the actual failure reason.
    /// The returned `String` is intentional because remote codes are bounded
    /// protocol data rather than compile-time literals.
    pub fn code(&self) -> String {
        match self {
            Self::Invalid { code, .. } | Self::Io { code, .. } | Self::Timeout { code } => {
                (*code).into()
            }
            Self::Protocol(_) => "LINUX_HELPER_PROTOCOL_FAILED".into(),
            Self::Capture(error) => error.code.clone(),
            Self::Remote { code, .. } => code.clone(),
            Self::UnexpectedResponse(_) => "LINUX_HELPER_RESPONSE_UNEXPECTED".into(),
            Self::StateUncertain { .. } => "LINUX_HELPER_STATE_UNCERTAIN".into(),
            Self::RecoveryRequired { .. } => "LINUX_HELPER_RECOVERY_REQUIRED".into(),
            Self::GenerationMismatch { .. } => "LINUX_HELPER_GENERATION_MISMATCH".into(),
        }
    }

    fn invalidates_session(&self) -> bool {
        matches!(
            self,
            Self::Protocol(_)
                | Self::UnexpectedResponse(_)
                | Self::GenerationMismatch { .. }
                | Self::Io { .. }
                | Self::Timeout { .. }
        )
    }

    pub fn into_capture_error(self) -> CaptureError {
        match self {
            Self::Capture(error) => error,
            Self::Remote {
                code,
                message,
                recovery_required,
                artifact,
            } => CaptureError {
                code,
                message,
                recovery_required,
                artifact,
            },
            Self::StateUncertain { source, .. } => {
                CaptureError::recovery("LINUX_HELPER_STATE_UNCERTAIN", source.to_string())
            }
            Self::RecoveryRequired { operation } => CaptureError::recovery(
                "LINUX_HELPER_RECOVERY_REQUIRED",
                format!("recovery is required before {operation}"),
            ),
            other => CaptureError::invalid(other.code(), other.to_string()),
        }
    }
}

fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    use super::*;
    use crate::sockscap::capture::helper_protocol::HelperResponse;

    struct FakeTransport {
        responses: VecDeque<HelperResponse>,
        requests: Arc<StdMutex<Vec<HelperRequest>>>,
        peer_pid: Option<u32>,
    }

    #[async_trait]
    impl LinuxHelperTransport for FakeTransport {
        fn verified_peer_pid(&self) -> Option<u32> {
            self.peer_pid
        }

        async fn request(
            &mut self,
            _request_id: &str,
            _generation: u64,
            request: HelperRequest,
        ) -> Result<HelperResponse, LinuxClientError> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .pop_front()
                .ok_or(LinuxClientError::UnexpectedResponse("fake exhausted"))
        }
    }

    struct FakeFactory {
        responses: StdMutex<VecDeque<HelperResponse>>,
        requests: Arc<StdMutex<Vec<HelperRequest>>>,
        peer_pid: Option<u32>,
    }

    struct LostCleanupResponseTransport {
        lose_response: bool,
        requests: Arc<StdMutex<Vec<HelperRequest>>>,
    }

    #[async_trait]
    impl LinuxHelperTransport for LostCleanupResponseTransport {
        async fn request(
            &mut self,
            _request_id: &str,
            _generation: u64,
            request: HelperRequest,
        ) -> Result<HelperResponse, LinuxClientError> {
            self.requests.lock().unwrap().push(request.clone());
            if self.lose_response {
                return Err(LinuxClientError::io(
                    "LINUX_HELPER_TEST_RESPONSE_LOST",
                    std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "cleanup response was lost",
                    ),
                ));
            }
            if matches!(request, HelperRequest::Recover { .. }) {
                Ok(HelperResponse::Recovered)
            } else {
                Err(LinuxClientError::UnexpectedResponse("lost-response retry"))
            }
        }
    }

    struct LostCleanupResponseFactory {
        connections: AtomicUsize,
        requests: Arc<StdMutex<Vec<HelperRequest>>>,
    }

    #[async_trait]
    impl LinuxHelperSessionFactory for LostCleanupResponseFactory {
        async fn connect(
            &self,
            _generation: u64,
        ) -> Result<Box<dyn LinuxHelperTransport>, LinuxClientError> {
            let connection = self.connections.fetch_add(1, AtomicOrdering::Relaxed);
            Ok(Box::new(LostCleanupResponseTransport {
                lose_response: connection == 0,
                requests: Arc::clone(&self.requests),
            }))
        }
    }

    #[async_trait]
    impl LinuxHelperSessionFactory for FakeFactory {
        async fn connect(
            &self,
            _generation: u64,
        ) -> Result<Box<dyn LinuxHelperTransport>, LinuxClientError> {
            Ok(Box::new(FakeTransport {
                responses: self.responses.lock().unwrap().drain(..).collect(),
                requests: Arc::clone(&self.requests),
                peer_pid: self.peer_pid,
            }))
        }
    }

    fn client_with(
        responses: Vec<HelperResponse>,
    ) -> (LinuxHelperClient, Arc<StdMutex<Vec<HelperRequest>>>) {
        client_with_peer(responses, None)
    }

    fn client_with_peer(
        responses: Vec<HelperResponse>,
        peer_pid: Option<u32>,
    ) -> (LinuxHelperClient, Arc<StdMutex<Vec<HelperRequest>>>) {
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let factory = Arc::new(FakeFactory {
            responses: StdMutex::new(responses.into()),
            requests: Arc::clone(&requests),
            peer_pid,
        });
        (LinuxHelperClient::new(7, factory).unwrap(), requests)
    }

    fn test_artifact() -> CaptureArtifactState {
        let mut spec = test_spec();
        spec.helper_pid = Some(4242);
        LinuxCapturePlan::from_spec(&spec, current_uid())
            .unwrap()
            .artifact(Vec::new())
    }

    fn test_spec() -> CaptureInstallSpec {
        CaptureInstallSpec {
            generation: 7,
            config_revision: 1,
            platform: CapturePlatform::Linux,
            mode: super::super::CaptureMode::Global,
            gateway: "127.0.0.1:1".parse().unwrap(),
            route_ipv6: true,
            selectors: Vec::new(),
            bypass_ips: Vec::new(),
            taomni_pid: 1,
            helper_pid: None,
        }
    }

    #[tokio::test]
    async fn probe_uses_typed_request_and_response() {
        let report = AdapterProbe {
            adapter: "linux_cgroup_nft_tun_v1".into(),
            platform: CapturePlatform::Linux,
            installed: true,
            privileged_helper_ready: false,
            signature_verified: true,
            global_available: false,
            application_group_available: false,
            runtime_pid_available: false,
            detail: "test".into(),
        };
        let (client, requests) = client_with(vec![HelperResponse::Probe {
            report: report.clone(),
        }]);
        assert_eq!(client.probe().await.unwrap(), report);
        assert!(matches!(
            requests.lock().unwrap().as_slice(),
            [HelperRequest::Probe]
        ));
    }

    #[tokio::test]
    async fn stale_spec_is_rejected_before_transport() {
        let (client, requests) = client_with(Vec::new());
        let spec = CaptureInstallSpec {
            generation: 8,
            config_revision: 1,
            platform: CapturePlatform::Linux,
            mode: super::super::CaptureMode::Global,
            gateway: "127.0.0.1:1".parse().unwrap(),
            route_ipv6: true,
            selectors: Vec::new(),
            bypass_ips: Vec::new(),
            taomni_pid: 1,
            helper_pid: Some(2),
        };
        assert_eq!(
            client.prepare(&spec).await.unwrap_err().code(),
            "LINUX_HELPER_SPEC_GENERATION_INVALID"
        );
        assert!(requests.lock().unwrap().is_empty());
    }

    #[test]
    fn launch_paths_are_not_webview_configurable() {
        let mut config = LinuxHelperLaunchConfig::default();
        assert!(config.validate().is_ok());
        config.helper_path = PathBuf::from("/tmp/evil-helper");
        assert_eq!(
            config.validate().unwrap_err().code(),
            "LINUX_HELPER_LAUNCH_PATH_INVALID"
        );

        let mut root_identity = LinuxHelperLaunchConfig::default();
        root_identity.authorized_uid = 0;
        assert_eq!(
            root_identity.validate().unwrap_err().code(),
            "LINUX_HELPER_LAUNCH_IDENTITY_INVALID"
        );

        let mut foreign_process = LinuxHelperLaunchConfig::default();
        foreign_process.expected_app_pid = std::process::id().saturating_add(1);
        assert_eq!(
            foreign_process.validate().unwrap_err().code(),
            "LINUX_HELPER_LAUNCH_IDENTITY_INVALID"
        );
    }

    #[tokio::test]
    async fn remote_error_preserves_recovery_artifact() {
        let artifact = CaptureArtifactState {
            adapter: "linux_cgroup_nft_tun_v1".into(),
            generation: 7,
            owner_uid: Some(1000),
            interface_names: vec!["ts7".into()],
            rule_ids: vec!["inet:taomni_sc_g7".into()],
            route_ids: vec!["ipv4-table:42007".into()],
            cgroup_paths: vec!["/sys/fs/cgroup/taomni.sockscap/g7/capture".into()],
            driver_service: None,
            extension_bundle_id: None,
            process_restores: Vec::new(),
        };
        let (client, _requests) = client_with(vec![HelperResponse::Error {
            code: "LINUX_CAPTURE_CLEANUP_INCOMPLETE".into(),
            message: "residue".into(),
            recovery_required: true,
            artifact: Some(artifact),
        }]);
        let error = client.probe().await.unwrap_err().into_capture_error();
        assert!(error.recovery_required);
        assert_eq!(error.code, "LINUX_CAPTURE_CLEANUP_INCOMPLETE");
        assert!(error.artifact.is_some());
    }

    #[tokio::test]
    async fn remote_error_keeps_authenticated_session_for_recovery() {
        let artifact = test_artifact();
        let (client, requests) = client_with(vec![
            HelperResponse::Error {
                code: "LINUX_CAPTURE_CLEANUP_INCOMPLETE".into(),
                message: "residue".into(),
                recovery_required: true,
                artifact: Some(artifact.clone()),
            },
            HelperResponse::Recovered,
        ]);
        assert!(client.probe().await.is_err());
        client.recover(&artifact).await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn lost_stop_response_can_reconnect_and_retry_recovery() {
        let artifact = test_artifact();
        let handle = CaptureHandle {
            generation: 7,
            config_revision: 1,
            helper_pid: 4242,
            artifact: artifact.clone(),
        };
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let factory = Arc::new(LostCleanupResponseFactory {
            connections: AtomicUsize::new(0),
            requests: Arc::clone(&requests),
        });
        let client = LinuxHelperClient::new(7, factory).unwrap();

        assert_eq!(
            client.stop(&handle).await.unwrap_err().code(),
            "LINUX_HELPER_STATE_UNCERTAIN"
        );
        client.recover(&artifact).await.unwrap();

        assert!(matches!(
            requests.lock().unwrap().as_slice(),
            [HelperRequest::Stop { .. }, HelperRequest::Recover { .. }]
        ));
    }

    #[tokio::test]
    async fn request_id_exhaustion_never_reaches_transport() {
        let (client, requests) = client_with(vec![HelperResponse::Probe {
            report: AdapterProbe {
                adapter: "unused".into(),
                platform: CapturePlatform::Linux,
                installed: false,
                privileged_helper_ready: false,
                signature_verified: false,
                global_available: false,
                application_group_available: false,
                runtime_pid_available: false,
                detail: "unused".into(),
            },
        }]);
        client.next_request.store(u64::MAX, Ordering::Relaxed);
        assert_eq!(
            client.probe().await.unwrap_err().code(),
            "LINUX_HELPER_REQUEST_ID_EXHAUSTED"
        );
        assert!(requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recovery_required_remote_error_blocks_normal_requests() {
        let report = AdapterProbe {
            adapter: LINUX_ADAPTER_ID.into(),
            platform: CapturePlatform::Linux,
            installed: true,
            privileged_helper_ready: true,
            signature_verified: true,
            global_available: false,
            application_group_available: false,
            runtime_pid_available: false,
            detail: "recovery".into(),
        };
        let (client, requests) = client_with(vec![
            HelperResponse::Error {
                code: "LINUX_CAPTURE_CLEANUP_INCOMPLETE".into(),
                message: "residue".into(),
                recovery_required: true,
                artifact: None,
            },
            HelperResponse::Recovered,
            HelperResponse::Probe { report },
        ]);
        assert!(client.probe().await.is_err());
        assert_eq!(
            client.probe().await.unwrap_err().code(),
            "LINUX_HELPER_RECOVERY_REQUIRED"
        );
        client.recover_generation().await.unwrap();
        assert!(client.probe().await.is_ok());
        assert_eq!(requests.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn readiness_line_is_exact_utf8_and_bounded_before_allocation() {
        let mut valid = BufReader::new(&b"SOCKSCAP_HELPER_READY /run/example.sock\n"[..]);
        assert_eq!(
            read_ready_line(&mut valid).await.unwrap(),
            "SOCKSCAP_HELPER_READY /run/example.sock"
        );

        let mut oversized = vec![b'a'; READY_LINE_BYTES + 1];
        oversized.push(b'\n');
        let mut oversized = BufReader::new(oversized.as_slice());
        assert_eq!(
            read_ready_line(&mut oversized).await.unwrap_err().code(),
            "LINUX_HELPER_READY_INVALID"
        );

        let mut incomplete = BufReader::new(&b"SOCKSCAP_HELPER_READY"[..]);
        assert_eq!(
            read_ready_line(&mut incomplete).await.unwrap_err().code(),
            "LINUX_HELPER_READY_MISSING"
        );
    }

    #[test]
    fn linux_artifact_identity_rejects_other_adapter_or_owner() {
        let (client, _) = client_with(Vec::new());
        let artifact = test_artifact();
        assert!(client.validate_linux_artifact(&artifact, "test").is_ok());

        let mut wrong_adapter = artifact.clone();
        wrong_adapter.adapter = "other_adapter".into();
        assert_eq!(
            client
                .validate_linux_artifact(&wrong_adapter, "test")
                .unwrap_err()
                .code(),
            "LINUX_HELPER_ARTIFACT_IDENTITY_INVALID"
        );

        let mut wrong_owner = artifact;
        wrong_owner.owner_uid = Some(current_uid().saturating_add(1));
        assert_eq!(
            client
                .validate_linux_artifact(&wrong_owner, "test")
                .unwrap_err()
                .code(),
            "LINUX_HELPER_ARTIFACT_IDENTITY_INVALID"
        );
    }

    #[tokio::test]
    async fn invalid_prepared_identity_poisoned_session_requires_recovery() {
        let spec = test_spec();
        let mut artifact = test_artifact();
        artifact.adapter = "other_adapter".into();
        let handle = CaptureHandle {
            generation: 7,
            config_revision: 1,
            helper_pid: 4242,
            artifact,
        };
        let report = AdapterProbe {
            adapter: LINUX_ADAPTER_ID.into(),
            platform: CapturePlatform::Linux,
            installed: true,
            privileged_helper_ready: true,
            signature_verified: true,
            global_available: false,
            application_group_available: false,
            runtime_pid_available: false,
            detail: "after-poison".into(),
        };
        let (client, requests) = client_with_peer(
            vec![
                HelperResponse::Prepared { handle },
                HelperResponse::Probe { report },
            ],
            Some(4242),
        );
        assert_eq!(
            client.prepare(&spec).await.unwrap_err().code(),
            "LINUX_HELPER_ARTIFACT_IDENTITY_INVALID"
        );
        assert_eq!(
            client.probe().await.unwrap_err().code(),
            "LINUX_HELPER_RECOVERY_REQUIRED"
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn heartbeat_pid_change_poisoned_session() {
        let artifact = test_artifact();
        let handle = CaptureHandle {
            generation: 7,
            config_revision: 1,
            helper_pid: 4242,
            artifact: artifact.clone(),
        };
        let (client, _) = client_with_peer(
            vec![HelperResponse::Heartbeat {
                helper_pid: 4243,
                generation: 7,
                artifact: Some(artifact),
            }],
            Some(4242),
        );
        assert_eq!(
            client.heartbeat(&handle).await.unwrap_err().code(),
            "LINUX_HELPER_PID_MISMATCH"
        );
        assert_eq!(
            client.probe().await.unwrap_err().code(),
            "LINUX_HELPER_RECOVERY_REQUIRED"
        );
    }
}
