use super::limits::DEFAULT_REQUEST_TIMEOUT;
use super::limits::DEFAULT_STDERR_LIMIT;
use super::permissions::AcpPermissionPrompt;
use crate::agent::acp_bridge::protocol;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

/// Spawn-time settings for one generic ACP stdio subprocess.
///
/// Environment values are intentionally omitted from `Debug` and are never
/// logged. `env_remove` lets the proxy policy explicitly erase inherited
/// variables before adding its resolved values.
#[derive(Clone)]
pub struct AcpProcessConfig {
    pub command: String,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    pub env_remove: BTreeSet<String>,
    pub request_timeout: Duration,
    pub stderr_limit: usize,
}

impl fmt::Debug for AcpProcessConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AcpProcessConfig")
            .field("command", &self.command)
            .field("arg_count", &self.args.len())
            .field("current_dir", &self.current_dir)
            .field("env_keys", &self.env.keys().collect::<Vec<_>>())
            .field("env_remove", &self.env_remove)
            .field("request_timeout", &self.request_timeout)
            .field("stderr_limit", &self.stderr_limit)
            .finish()
    }
}

impl AcpProcessConfig {
    pub fn new(command: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            command: command.into(),
            args,
            current_dir: None,
            env: BTreeMap::new(),
            env_remove: BTreeSet::new(),
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            stderr_limit: DEFAULT_STDERR_LIMIT,
        }
    }

    pub fn with_current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn without_env(mut self, key: impl Into<String>) -> Self {
        self.env_remove.insert(key.into());
        self
    }

    pub fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    pub fn with_stderr_limit(mut self, limit: usize) -> Self {
        self.stderr_limit = limit.max(256);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpRuntimeError {
    InvalidCommand,
    SpawnFailed(String),
    StdioUnavailable(&'static str),
    SerializeFailed,
    WriteFailed(String),
    RequestTimedOut { method: String },
    ResponseChannelClosed,
    Rpc { code: i64, message: String },
    Protocol(String),
    UnsupportedProtocolVersion(u64),
    ProcessExited,
    Stopped,
    TurnAlreadyActive,
    PermissionNotPending,
    PermissionOptionUnavailable,
}

impl fmt::Display for AcpRuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCommand => f.write_str("ACP command is empty"),
            Self::SpawnFailed(message) => write!(f, "failed to spawn ACP agent: {message}"),
            Self::StdioUnavailable(stream) => {
                write!(f, "ACP agent did not expose piped {stream}")
            }
            Self::SerializeFailed => f.write_str("failed to serialize ACP request"),
            Self::WriteFailed(message) => write!(f, "failed to write ACP request: {message}"),
            Self::RequestTimedOut { method } => write!(f, "ACP request `{method}` timed out"),
            Self::ResponseChannelClosed => f.write_str("ACP response channel closed"),
            Self::Rpc { code, message } => write!(f, "ACP error {code}: {message}"),
            Self::Protocol(message) => write!(f, "ACP protocol error: {message}"),
            Self::UnsupportedProtocolVersion(version) => {
                write!(
                    f,
                    "ACP agent selected unsupported protocol version {version}"
                )
            }
            Self::ProcessExited => f.write_str("ACP agent process exited"),
            Self::Stopped => f.write_str("ACP agent process is stopped"),
            Self::TurnAlreadyActive => {
                f.write_str("an ACP prompt is already active for this process")
            }
            Self::PermissionNotPending => f.write_str("ACP permission prompt is no longer pending"),
            Self::PermissionOptionUnavailable => {
                f.write_str("ACP permission option is not available for this prompt")
            }
        }
    }
}

impl std::error::Error for AcpRuntimeError {}

#[derive(Debug, Clone, PartialEq)]
pub enum AcpRuntimeEvent {
    SessionUpdate(protocol::AcpSessionUpdate),
    PermissionRequest(AcpPermissionPrompt),
    /// The native permission request has received a selected/cancelled RPC
    /// outcome (or its response path has closed), so its UI gate is stale.
    PermissionResolved {
        call_id: String,
    },
    ProtocolWarning {
        message: String,
    },
    Closed,
}
