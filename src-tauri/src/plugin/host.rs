//! Deterministic supervision primitives for an out-of-process plugin host.
//!
//! The platform process adapter is intentionally kept outside this module. It
//! owns spawning and killing the executable (including Job Object,
//! `PDEATHSIG`, and macOS cleanup). This module owns the protocol lifecycle so
//! that timeout, cancellation, heartbeat, and restart behavior can be tested
//! without starting a desktop process.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use taomni_plugin_api::{
    CancelRequest, ErrorCode, HandshakeRequest, HandshakeResponse, Heartbeat, RequestId, RpcError,
    RpcMessage, RpcNotification, RpcResponse, validate_token, validate_versions,
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
    pub fn new(plugin_id: impl Into<String>, config: HostSupervisorConfig, _now_ms: u64) -> Self {
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
        let timeout_ms = HostSupervisorConfig::millis(self.config.request_timeout);
        self.register_request_until(id, now_ms.saturating_add(timeout_ms))
    }

    /// A core-owned lifecycle/snapshot deadline may differ from the ordinary
    /// invoke timeout. Never use a deadline supplied by host/renderer JSON.
    pub fn register_request_until(
        &mut self,
        id: RequestId,
        deadline_ms: u64,
    ) -> Result<(), RpcError> {
        if self.state != HostState::Running {
            return Err(RpcError::from_code(ErrorCode::InvalidState));
        }
        if self.pending.contains_key(&id) {
            return Err(RpcError::from_code(ErrorCode::DuplicateRequest));
        }
        self.pending.insert(id, PendingRequest { deadline_ms });
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

    pub fn record_heartbeat(&mut self, _heartbeat: &Heartbeat, now_ms: u64) -> bool {
        if self.state != HostState::Running {
            return false;
        }
        // Peer clocks are untrusted and may use a different epoch. Only our
        // monotonic receive time can extend the liveness deadline.
        self.last_heartbeat_ms = Some(now_ms);
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

    pub fn config(&self) -> &HostSupervisorConfig {
        &self.config
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

#[path = "host/containment.rs"]
mod containment;
#[path = "host/process.rs"]
mod process;

pub use process::{
    HostCancellation, HostProcess, HostProcessError, HostProfileConfig, HostServiceConfig, HostTick,
};

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
