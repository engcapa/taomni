//! Deterministic supervision primitives for an out-of-process plugin host.
//!
//! The platform process adapter is intentionally kept outside this module. It
//! owns spawning and killing the executable (including Job Object,
//! `PDEATHSIG`, and macOS cleanup). This module owns the protocol lifecycle so
//! that timeout, cancellation, heartbeat, and restart behavior can be tested
//! without starting a desktop process.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use taomni_plugin_api::{
    API_VERSION, CancelRequest, ErrorCode, HandshakeRequest, HandshakeResponse, Heartbeat,
    PROTOCOL_VERSION, RequestId, RpcError, RpcMessage, RpcNotification, RpcRequest, RpcResponse,
    validate_token, validate_versions,
};
use thiserror::Error;

/// Maximum JSON-RPC line accepted from a plugin host.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Newline-delimited JSON framing errors. A frame is always one JSON value;
/// partial writes are retained by [`JsonLineCodec`] until the next `push`.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("plugin RPC frame exceeds {max} bytes")]
    TooLarge { max: usize },
    #[error("plugin RPC frame is not valid UTF-8")]
    InvalidUtf8,
    #[error("plugin RPC frame is invalid JSON: {0}")]
    InvalidJson(String),
}

/// Incremental JSON-lines codec for the host's stdin/stdout control channel.
#[derive(Debug, Clone)]
pub struct JsonLineCodec {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
}

impl Default for JsonLineCodec {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_FRAME_BYTES)
    }
}

impl JsonLineCodec {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_bytes: max_frame_bytes.max(1),
        }
    }

    /// Feed bytes from stdout and return every complete JSON-RPC message.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<RpcMessage>, FrameError> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > self.max_frame_bytes && !self.buffer.contains(&b'\n') {
            self.buffer.clear();
            return Err(FrameError::TooLarge {
                max: self.max_frame_bytes,
            });
        }

        let mut messages = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            if line.len() > self.max_frame_bytes {
                return Err(FrameError::TooLarge {
                    max: self.max_frame_bytes,
                });
            }
            let text = std::str::from_utf8(&line).map_err(|_| FrameError::InvalidUtf8)?;
            let message = serde_json::from_str(text)
                .map_err(|error| FrameError::InvalidJson(error.to_string()))?;
            messages.push(message);
        }
        if self.buffer.len() > self.max_frame_bytes {
            self.buffer.clear();
            return Err(FrameError::TooLarge {
                max: self.max_frame_bytes,
            });
        }
        Ok(messages)
    }

    /// Encode a JSON-RPC message as one newline-delimited frame.
    pub fn encode(message: &RpcMessage) -> Result<Vec<u8>, FrameError> {
        let mut bytes = serde_json::to_vec(message)
            .map_err(|error| FrameError::InvalidJson(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Crashed,
    RestartExhausted,
}

#[derive(Debug, Clone)]
pub struct HostSupervisorConfig {
    pub request_timeout: Duration,
    pub heartbeat_timeout: Duration,
    pub max_restarts: u32,
    pub restart_window: Duration,
    pub restart_backoff: Duration,
}

impl Default for HostSupervisorConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(30),
            heartbeat_timeout: Duration::from_secs(10),
            max_restarts: 3,
            restart_window: Duration::from_secs(60),
            restart_backoff: Duration::from_millis(250),
        }
    }
}

impl HostSupervisorConfig {
    fn millis(value: Duration) -> u64 {
        value.as_millis().min(u128::from(u64::MAX)) as u64
    }
}

#[derive(Debug, Clone)]
struct PendingRequest {
    deadline_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartAction {
    Restart { attempt: u32, after: Duration },
    Exhausted,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SupervisorEvent {
    RequestTimeout(RpcResponse),
    HeartbeatTimeout { elapsed_ms: u64 },
}

/// Protocol and lifecycle state for one plugin host process.
#[derive(Debug, Clone)]
pub struct HostSupervisor {
    plugin_id: String,
    config: HostSupervisorConfig,
    state: HostState,
    pending: HashMap<RequestId, PendingRequest>,
    last_heartbeat_ms: Option<u64>,
    restart_attempts: Vec<u64>,
}

impl HostSupervisor {
    pub fn new(plugin_id: impl Into<String>, config: HostSupervisorConfig, now_ms: u64) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            config,
            state: HostState::Starting,
            pending: HashMap::new(),
            last_heartbeat_ms: None,
            restart_attempts: Vec::new(),
        }
    }

    pub fn state(&self) -> HostState {
        self.state
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn last_heartbeat_ms(&self) -> Option<u64> {
        self.last_heartbeat_ms
    }

    /// Validate a host handshake and transition from Starting to Running.
    pub fn accept_handshake(
        &mut self,
        request: &HandshakeRequest,
        expected_token: &str,
        now_ms: u64,
    ) -> HandshakeResponse {
        let rejected = |error: RpcError| HandshakeResponse::rejected(error);
        if request.plugin_id != self.plugin_id {
            return rejected(RpcError::new(
                ErrorCode::InvalidParams,
                "plugin id does not match the supervised host",
            ));
        }
        if let Err(error) = validate_versions(request.api_version, request.protocol_version) {
            return rejected(error);
        }
        if let Err(error) = validate_token(expected_token, &request.token) {
            return rejected(error);
        }
        self.state = HostState::Running;
        self.last_heartbeat_ms = Some(now_ms);
        HandshakeResponse::accepted(self.config.heartbeat_timeout.as_millis() as u64)
    }

    /// Track a request before writing it to the child stdin.
    pub fn register_request(&mut self, id: RequestId, now_ms: u64) -> Result<(), RpcError> {
        if self.state != HostState::Running {
            return Err(RpcError::from_code(ErrorCode::InvalidState));
        }
        if self.pending.contains_key(&id) {
            return Err(RpcError::from_code(ErrorCode::DuplicateRequest));
        }
        let timeout_ms = HostSupervisorConfig::millis(self.config.request_timeout);
        self.pending.insert(
            id,
            PendingRequest {
                deadline_ms: now_ms.saturating_add(timeout_ms),
            },
        );
        Ok(())
    }

    /// Accept a response and remove its pending request. Unknown responses are
    /// ignored by the caller because they may belong to a request cancelled by
    /// a timeout race.
    pub fn complete_response(&mut self, response: &RpcResponse) -> bool {
        response
            .id
            .as_ref()
            .is_some_and(|id| self.pending.remove(id).is_some())
    }

    /// Cancel a pending request and return the notification that must be sent
    /// to the host. The cancellation itself has no JSON-RPC response.
    pub fn cancel_request(
        &mut self,
        id: &RequestId,
        reason: Option<String>,
    ) -> Option<RpcNotification> {
        self.pending.remove(id)?;
        Some(
            CancelRequest {
                request_id: id.clone(),
                reason,
            }
            .notification(),
        )
    }

    pub fn record_heartbeat(&mut self, heartbeat: &Heartbeat, now_ms: u64) -> bool {
        if self.state != HostState::Running {
            return false;
        }
        self.last_heartbeat_ms = Some(now_ms.max(heartbeat.timestamp_ms));
        true
    }

    /// Emit timeout and heartbeat events that became due at `now_ms`.
    pub fn poll(&mut self, now_ms: u64) -> Vec<SupervisorEvent> {
        let mut events = Vec::new();
        let expired = self
            .pending
            .iter()
            .filter_map(|(id, request)| (request.deadline_ms <= now_ms).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in expired {
            self.pending.remove(&id);
            events.push(SupervisorEvent::RequestTimeout(RpcResponse::failure(
                Some(id),
                RpcError::new(ErrorCode::RequestTimeout, "plugin request timed out"),
            )));
        }
        if self.state == HostState::Running {
            if let Some(last) = self.last_heartbeat_ms {
                let elapsed_ms = now_ms.saturating_sub(last);
                if elapsed_ms >= HostSupervisorConfig::millis(self.config.heartbeat_timeout) {
                    self.state = HostState::Crashed;
                    events.push(SupervisorEvent::HeartbeatTimeout { elapsed_ms });
                }
            }
        }
        events
    }

    /// Mark the child as exited and decide whether a bounded restart is safe.
    pub fn host_exited(&mut self, now_ms: u64) -> RestartAction {
        self.state = HostState::Crashed;
        let window_ms = HostSupervisorConfig::millis(self.config.restart_window);
        self.restart_attempts
            .retain(|attempt| now_ms.saturating_sub(*attempt) <= window_ms);
        if self.restart_attempts.len() as u32 >= self.config.max_restarts {
            self.state = HostState::RestartExhausted;
            return RestartAction::Exhausted;
        }
        self.restart_attempts.push(now_ms);
        let attempt = self.restart_attempts.len() as u32;
        let multiplier = u32::saturating_pow(2, attempt.saturating_sub(1));
        RestartAction::Restart {
            attempt,
            after: self.config.restart_backoff.saturating_mul(multiplier),
        }
    }

    /// Reset protocol state after the process adapter spawned a replacement.
    pub fn mark_restarted(&mut self, now_ms: u64) {
        self.state = HostState::Starting;
        self.pending.clear();
        self.last_heartbeat_ms = Some(now_ms);
    }

    pub fn stop(&mut self) {
        self.state = HostState::Stopping;
        self.pending.clear();
        self.state = HostState::Stopped;
        self.last_heartbeat_ms = None;
    }
}

/// Build a JSON-RPC request only after registering its id, keeping duplicate
/// request detection in the supervisor's single state owner.
pub fn request_message(
    supervisor: &mut HostSupervisor,
    id: RequestId,
    method: impl Into<String>,
    params: Option<serde_json::Value>,
    now_ms: u64,
) -> Result<RpcMessage, RpcError> {
    supervisor.register_request(id.clone(), now_ms)?;
    Ok(RpcMessage::Request(taomni_plugin_api::RpcRequest::new(
        id, method, params,
    )))
}

/// Errors raised by the concrete stdio process adapter.  The protocol state
/// machine above remains independently testable; this adapter is the narrow
/// boundary that turns it into a request/response client for a real host.
#[derive(Debug, thiserror::Error)]
pub enum HostProcessError {
    #[error("failed to spawn plugin host: {0}")]
    Spawn(#[source] io::Error),
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
    #[error("plugin host exited unexpectedly")]
    Crashed,
    #[error("plugin host returned an unexpected response")]
    UnexpectedResponse,
}

type HostReadResult = Result<RpcMessage, HostProcessError>;

/// A single supervised plugin host process.
///
/// The child stdout is consumed by a dedicated reader thread so a synchronous
/// Tauri command can enforce a hard response deadline with `recv_timeout`.
/// Every invocation is serialized through the owning mutex in `PluginRegistry`;
/// this keeps request IDs and stdio writes ordered without exposing the child
/// handles to the renderer.
#[derive(Debug)]
pub struct HostProcess {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<HostReadResult>,
    supervisor: HostSupervisor,
    token: String,
    next_id: u64,
    started_at: Instant,
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
        let token = process_token();
        let mut command = Command::new(host);
        command
            .current_dir(working_dir)
            .env("TAOMNI_PLUGIN_TOKEN", &token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(HostProcessError::Spawn)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            HostProcessError::Io(io::Error::other("plugin host stdin was not piped"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            HostProcessError::Io(io::Error::other("plugin host stdout was not piped"))
        })?;
        let (sender, responses) = mpsc::channel();
        spawn_reader(stdout, sender);
        let started_at = Instant::now();
        let mut process = Self {
            child,
            stdin,
            responses,
            supervisor: HostSupervisor::new(plugin_id, config.clone(), 0),
            token,
            next_id: 0,
            started_at,
        };
        let handshake_id = process.next_request_id();
        let request = RpcRequest::new(
            handshake_id.clone(),
            "plugin/handshake",
            Some(
                serde_json::to_value(HandshakeRequest::new(
                    plugin_id,
                    plugin_version,
                    process.token.clone(),
                    commands.to_vec(),
                    permissions.to_vec(),
                ))
                .map_err(|error| HostProcessError::Handshake(error.to_string()))?,
            ),
        );
        process.write_message(&RpcMessage::Request(request))?;
        let response = process.receive_response(&handshake_id, config.request_timeout)?;
        let result = response
            .result
            .ok_or_else(|| response_error(response.error, "handshake returned no result"))?;
        let handshake: HandshakeResponse = serde_json::from_value(result)
            .map_err(|error| HostProcessError::Handshake(error.to_string()))?;
        if let Err(error) = validate_versions(handshake.api_version, handshake.protocol_version) {
            return Err(HostProcessError::Handshake(error.message));
        }
        if !handshake.accepted {
            return Err(HostProcessError::Handshake(
                handshake
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "host rejected handshake".to_owned()),
            ));
        }
        // The core validates the request it sent as well as the response
        // version above. This keeps a malicious or stale host from entering
        // the Running state merely by returning `{accepted:true}`.
        let handshake_request = HandshakeRequest::new(
            plugin_id,
            plugin_version,
            &process.token,
            commands.to_vec(),
            permissions.to_vec(),
        );
        let accepted = process.supervisor.accept_handshake(
            &handshake_request,
            &process.token,
            process.elapsed_ms(),
        );
        if !accepted.accepted {
            return Err(HostProcessError::Handshake(
                accepted
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "core rejected its own handshake".to_owned()),
            ));
        }
        Ok(process)
    }

    pub fn invoke(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, HostProcessError> {
        if self.supervisor.state() != HostState::Running {
            return Err(HostProcessError::Crashed);
        }
        let id = self.next_request_id();
        let now_ms = self.elapsed_ms();
        let message = request_message(&mut self.supervisor, id.clone(), method, params, now_ms)
            .map_err(|error| HostProcessError::Rpc {
                code: error.code,
                message: error.message,
            })?;
        self.write_message(&message)?;
        let response = match self.receive_response(&id, self.supervisor.config.request_timeout) {
            Ok(response) => response,
            Err(error @ HostProcessError::Timeout) => {
                let _ = self
                    .supervisor
                    .cancel_request(&id, Some("request timeout".into()));
                self.kill();
                return Err(error);
            }
            Err(error) => {
                self.kill();
                return Err(error);
            }
        };
        if !self.supervisor.complete_response(&response) {
            return Err(HostProcessError::UnexpectedResponse);
        }
        if let Some(error) = response.error {
            return Err(HostProcessError::Rpc {
                code: error.code,
                message: error.message,
            });
        }
        response.result.ok_or(HostProcessError::UnexpectedResponse)
    }

    pub fn stop(&mut self) {
        self.supervisor.stop();
        self.kill();
    }

    fn write_message(&mut self, message: &RpcMessage) -> Result<(), HostProcessError> {
        let bytes = JsonLineCodec::encode(message)?;
        self.stdin.write_all(&bytes).map_err(HostProcessError::Io)?;
        self.stdin.flush().map_err(HostProcessError::Io)
    }

    fn receive_response(
        &mut self,
        expected_id: &RequestId,
        timeout: Duration,
    ) -> Result<RpcResponse, HostProcessError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let message = match self.responses.recv_timeout(remaining) {
                Ok(message) => message?,
                Err(RecvTimeoutError::Timeout) => return Err(HostProcessError::Timeout),
                Err(RecvTimeoutError::Disconnected) => return Err(HostProcessError::Crashed),
            };
            match message {
                RpcMessage::Response(response) => {
                    if response.id.as_ref() == Some(expected_id) {
                        return Ok(response);
                    }
                }
                RpcMessage::Notification(notification)
                    if notification.method == Heartbeat::METHOD =>
                {
                    if let Some(params) = notification.params {
                        if let Ok(heartbeat) = serde_json::from_value::<Heartbeat>(params) {
                            let _ = self
                                .supervisor
                                .record_heartbeat(&heartbeat, self.elapsed_ms());
                        }
                    }
                }
                RpcMessage::Notification(_) | RpcMessage::Request(_) => {}
            }
        }
    }

    fn next_request_id(&mut self) -> RequestId {
        self.next_id = self.next_id.saturating_add(1);
        format!("taomni-{}", self.next_id).into()
    }

    fn elapsed_ms(&self) -> u64 {
        self.started_at
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    fn kill(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

fn spawn_reader(stdout: impl std::io::Read + Send + 'static, sender: Sender<HostReadResult>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut codec = JsonLineCodec::default();
        let mut bytes = [0u8; 8 * 1024];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => match codec.push(&bytes[..count]) {
                    Ok(messages) => {
                        for message in messages {
                            if sender.send(Ok(message)).is_err() {
                                return;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(HostProcessError::Frame(error)));
                        return;
                    }
                },
                Err(error) => {
                    let _ = sender.send(Err(HostProcessError::Io(error)));
                    return;
                }
            }
        }
        let _ = sender.send(Err(HostProcessError::Crashed));
    });
}

fn response_error(error: Option<RpcError>, fallback: &str) -> HostProcessError {
    match error {
        Some(error) => HostProcessError::Rpc {
            code: error.code,
            message: error.message,
        },
        None => HostProcessError::Handshake(fallback.to_owned()),
    }
}

fn process_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    // Hex avoids shell/JSON escaping surprises and remains easy to redact in
    // diagnostics. The token is generated once per process and never stored
    // in the plugin registry or on disk.
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codec_handles_partial_frames_and_crlf() {
        let message = RpcMessage::Request(taomni_plugin_api::RpcRequest::new(
            "one",
            "ping",
            Some(json!({ "ok": true })),
        ));
        let encoded = JsonLineCodec::encode(&message).unwrap();
        let split = encoded.len() / 2;
        let mut codec = JsonLineCodec::default();
        assert!(codec.push(&encoded[..split]).unwrap().is_empty());
        let mut tail = encoded[split..].to_vec();
        assert_eq!(tail.pop(), Some(b'\n'));
        tail.push(b'\r');
        tail.push(b'\n');
        let messages = codec.push(&tail).unwrap();
        assert_eq!(messages, vec![message]);
        assert_eq!(codec.buffered_len(), 0);
    }

    #[test]
    fn codec_rejects_oversized_partial_frame() {
        let mut codec = JsonLineCodec::new(3);
        assert_eq!(
            codec.push(b"abcd").unwrap_err(),
            FrameError::TooLarge { max: 3 }
        );
    }

    fn supervisor() -> HostSupervisor {
        HostSupervisor::new(
            "taomni-plugin-mfa",
            HostSupervisorConfig {
                request_timeout: Duration::from_millis(50),
                heartbeat_timeout: Duration::from_millis(100),
                max_restarts: 2,
                restart_window: Duration::from_millis(1_000),
                restart_backoff: Duration::from_millis(10),
            },
            0,
        )
    }

    #[test]
    fn handshake_requires_plugin_and_token_then_tracks_requests() {
        let mut supervisor = supervisor();
        let mut request = HandshakeRequest::new(
            "taomni-plugin-mfa",
            "1.0.0",
            "secret",
            vec!["mfa.scan".into()],
            vec!["capture.screen".into()],
        );
        let rejected = supervisor.accept_handshake(&request, "secret", 10);
        assert!(rejected.accepted);
        assert_eq!(supervisor.state(), HostState::Running);
        assert!(supervisor.register_request("r1".into(), 10).is_ok());
        assert_eq!(
            supervisor
                .register_request("r1".into(), 10)
                .unwrap_err()
                .code,
            ErrorCode::DuplicateRequest.as_i32()
        );
        request.token = "wrong".into();
        assert!(!supervisor.accept_handshake(&request, "secret", 10).accepted);
    }

    #[test]
    fn poll_emits_timeout_and_heartbeat_failure() {
        let mut supervisor = supervisor();
        let request = HandshakeRequest::new("taomni-plugin-mfa", "1", "secret", vec![], vec![]);
        assert!(supervisor.accept_handshake(&request, "secret", 0).accepted);
        supervisor.register_request("r1".into(), 0).unwrap();
        let events = supervisor.poll(50);
        assert!(matches!(events[0], SupervisorEvent::RequestTimeout(_)));
        assert_eq!(supervisor.pending_count(), 0);
        let events = supervisor.poll(100);
        assert!(matches!(
            events[0],
            SupervisorEvent::HeartbeatTimeout { elapsed_ms: 100 }
        ));
        assert_eq!(supervisor.state(), HostState::Crashed);
    }

    #[test]
    fn cancellation_and_heartbeat_keep_host_running() {
        let mut supervisor = supervisor();
        let request = HandshakeRequest::new("taomni-plugin-mfa", "1", "secret", vec![], vec![]);
        assert!(supervisor.accept_handshake(&request, "secret", 0).accepted);
        supervisor.register_request("r1".into(), 0).unwrap();
        let notification = supervisor
            .cancel_request(&"r1".into(), Some("user".into()))
            .unwrap();
        assert_eq!(notification.method, CancelRequest::METHOD);
        assert!(supervisor.record_heartbeat(&Heartbeat { timestamp_ms: 20 }, 20));
        assert!(supervisor.poll(100).is_empty());
        assert_eq!(supervisor.state(), HostState::Running);
    }

    #[test]
    fn crash_restart_is_bounded_and_uses_backoff() {
        let mut supervisor = supervisor();
        assert_eq!(
            supervisor.host_exited(0),
            RestartAction::Restart {
                attempt: 1,
                after: Duration::from_millis(10)
            }
        );
        supervisor.mark_restarted(10);
        assert_eq!(
            supervisor.host_exited(20),
            RestartAction::Restart {
                attempt: 2,
                after: Duration::from_millis(20)
            }
        );
        assert_eq!(supervisor.host_exited(30), RestartAction::Exhausted);
        assert_eq!(supervisor.state(), HostState::RestartExhausted);
    }

    #[test]
    fn request_message_registers_before_encoding() {
        let mut supervisor = supervisor();
        let request = HandshakeRequest::new("taomni-plugin-mfa", "1", "secret", vec![], vec![]);
        assert!(supervisor.accept_handshake(&request, "secret", 0).accepted);
        let message = request_message(
            &mut supervisor,
            "r1".into(),
            "mfa.scan",
            Some(json!({ "full": true })),
            1,
        )
        .unwrap();
        assert!(matches!(message, RpcMessage::Request(_)));
        assert_eq!(supervisor.pending_count(), 1);
    }
}
