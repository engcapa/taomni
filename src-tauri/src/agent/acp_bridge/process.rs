use super::protocol::{
    self, ACP_PROTOCOL_VERSION, AcpAgentInfo, AcpIncomingMessage, AcpNotification, AcpPromptResult,
    AcpRequest, AcpRequestId, METHOD_SESSION_UPDATE, authenticate_request, cancel_notification,
    initialize_request, load_session_request, new_session_request, parse_incoming_line,
    parse_initialize_result, parse_prompt_result, parse_session_update, prompt_request,
    session_id_from_response,
};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard as StdMutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, broadcast, oneshot};

pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_STDERR_LIMIT: usize = 8 * 1024;
const EVENT_CHANNEL_CAPACITY: usize = 256;

type PendingMap = Arc<StdMutex<HashMap<AcpRequestId, PendingRequest>>>;
type SharedStdin = Arc<Mutex<Option<ChildStdin>>>;

struct PendingRequest {
    sender: oneshot::Sender<Result<Value, AcpRuntimeError>>,
}

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
        }
    }
}

impl std::error::Error for AcpRuntimeError {}

#[derive(Debug, Clone, PartialEq)]
pub enum AcpRuntimeEvent {
    SessionUpdate(protocol::AcpSessionUpdate),
    ProtocolWarning { message: String },
    Closed,
}

/// One long-lived ACP agent subprocess. The runtime is intentionally provider
/// neutral; Grok-specific command discovery and authentication selection live
/// in profile configuration, not in the request router.
pub struct AcpProcess {
    child: Mutex<Option<Child>>,
    stdin: SharedStdin,
    pending: PendingMap,
    events: broadcast::Sender<AcpRuntimeEvent>,
    next_id: AtomicU64,
    stopped: Arc<AtomicBool>,
    request_timeout: Duration,
    stderr_buf: Arc<Mutex<String>>,
    unknown_notifications: Arc<AtomicU64>,
    turn_active: AtomicBool,
    pub last_active_at: StdMutex<Instant>,
}

impl AcpProcess {
    pub async fn spawn(config: AcpProcessConfig) -> Result<Self, AcpRuntimeError> {
        let command = config.command.trim();
        if command.is_empty() {
            return Err(AcpRuntimeError::InvalidCommand);
        }

        let mut cmd = Command::new(command);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(current_dir) = &config.current_dir {
            cmd.current_dir(current_dir);
        }
        for key in &config.env_remove {
            cmd.env_remove(key);
        }
        for (key, value) in &config.env {
            if !key.trim().is_empty() {
                cmd.env(key, value);
            }
        }
        no_console_window(&mut cmd);

        let mut child = cmd.spawn().map_err(|error| {
            AcpRuntimeError::SpawnFailed(sanitize_diagnostic(&error.to_string()))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or(AcpRuntimeError::StdioUnavailable("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(AcpRuntimeError::StdioUnavailable("stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(AcpRuntimeError::StdioUnavailable("stderr"))?;

        let stdin = Arc::new(Mutex::new(Some(stdin)));
        let pending = Arc::new(StdMutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let stopped = Arc::new(AtomicBool::new(false));
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let unknown_notifications = Arc::new(AtomicU64::new(0));

        spawn_stdout_reader(
            stdout,
            stdin.clone(),
            pending.clone(),
            events.clone(),
            stopped.clone(),
            unknown_notifications.clone(),
        );
        spawn_stderr_reader(stderr, stderr_buf.clone(), config.stderr_limit);

        Ok(Self {
            child: Mutex::new(Some(child)),
            stdin,
            pending,
            events,
            next_id: AtomicU64::new(1),
            stopped,
            request_timeout: config.request_timeout,
            stderr_buf,
            unknown_notifications,
            turn_active: AtomicBool::new(false),
            last_active_at: StdMutex::new(Instant::now()),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AcpRuntimeEvent> {
        self.events.subscribe()
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn is_turn_active(&self) -> bool {
        self.turn_active.load(Ordering::SeqCst)
    }

    pub fn unknown_notification_count(&self) -> u64 {
        self.unknown_notifications.load(Ordering::Relaxed)
    }

    pub async fn stderr(&self) -> String {
        self.stderr_buf.lock().await.clone()
    }

    pub async fn initialize(&self) -> Result<AcpAgentInfo, AcpRuntimeError> {
        let request = initialize_request(self.allocate_id(), "taomni", env!("CARGO_PKG_VERSION"));
        let result = self.send_request(request).await?;
        let info = parse_initialize_result(&result)
            .map_err(|error| AcpRuntimeError::Protocol(error.to_string()))?;
        if info.protocol_version != ACP_PROTOCOL_VERSION {
            return Err(AcpRuntimeError::UnsupportedProtocolVersion(
                info.protocol_version,
            ));
        }
        Ok(info)
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<(), AcpRuntimeError> {
        let request = authenticate_request(self.allocate_id(), method_id);
        self.send_request(request).await.map(|_| ())
    }

    pub async fn new_session(
        &self,
        cwd: &str,
        mcp_servers: Vec<Value>,
    ) -> Result<String, AcpRuntimeError> {
        let request = new_session_request(self.allocate_id(), cwd, mcp_servers);
        let result = self.send_request(request).await?;
        session_id_from_response(&result)
            .map_err(|error| AcpRuntimeError::Protocol(error.to_string()))
    }

    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<Value>,
    ) -> Result<(), AcpRuntimeError> {
        let request = load_session_request(self.allocate_id(), session_id, cwd, mcp_servers);
        self.send_request(request).await.map(|_| ())
    }

    pub async fn prompt(
        &self,
        session_id: &str,
        text: &str,
    ) -> Result<AcpPromptResult, AcpRuntimeError> {
        let _turn = self.begin_turn()?;
        let request = prompt_request(self.allocate_id(), session_id, text);
        let result = self.send_request(request).await?;
        parse_prompt_result(&result).map_err(|error| AcpRuntimeError::Protocol(error.to_string()))
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpRuntimeError> {
        self.send_notification(cancel_notification(session_id))
            .await
    }

    /// Send an extension request. This keeps the runtime generic and is useful
    /// for capability-gated ACP additions without weakening inbound security.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, AcpRuntimeError> {
        let request = AcpRequest::new(self.allocate_id(), method, params);
        self.send_request(request).await
    }

    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        *self.stdin.lock().await = None;
        fail_pending(&self.pending, AcpRuntimeError::Stopped);
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.touch();
    }

    fn allocate_id(&self) -> AcpRequestId {
        AcpRequestId::Number(self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    async fn send_request(&self, request: AcpRequest) -> Result<Value, AcpRuntimeError> {
        if self.is_stopped() {
            return Err(AcpRuntimeError::Stopped);
        }

        let id = request.id.clone();
        let method = request.method.clone();
        let (sender, receiver) = oneshot::channel();
        lock_unpoisoned(&self.pending).insert(id.clone(), PendingRequest { sender });

        if let Err(error) = write_message(&self.stdin, &request, &self.stopped).await {
            lock_unpoisoned(&self.pending).remove(&id);
            return Err(error);
        }
        self.touch();

        match tokio::time::timeout(self.request_timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AcpRuntimeError::ResponseChannelClosed),
            Err(_) => {
                lock_unpoisoned(&self.pending).remove(&id);
                Err(AcpRuntimeError::RequestTimedOut {
                    method: truncate_method(&method),
                })
            }
        }
    }

    async fn send_notification(
        &self,
        notification: AcpNotification,
    ) -> Result<(), AcpRuntimeError> {
        write_message(&self.stdin, &notification, &self.stopped).await?;
        self.touch();
        Ok(())
    }

    fn begin_turn(&self) -> Result<TurnGuard<'_>, AcpRuntimeError> {
        self.turn_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| AcpRuntimeError::TurnAlreadyActive)?;
        self.touch();
        Ok(TurnGuard {
            active: &self.turn_active,
            last_active_at: &self.last_active_at,
        })
    }

    fn touch(&self) {
        *lock_unpoisoned(&self.last_active_at) = Instant::now();
    }
}

impl Drop for AcpProcess {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        fail_pending(&self.pending, AcpRuntimeError::Stopped);
        if let Ok(mut stdin) = self.stdin.try_lock() {
            stdin.take();
        }
        if let Ok(mut child) = self.child.try_lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
    }
}

struct TurnGuard<'a> {
    active: &'a AtomicBool,
    last_active_at: &'a StdMutex<Instant>,
}

impl Drop for TurnGuard<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        *lock_unpoisoned(self.last_active_at) = Instant::now();
    }
}

async fn write_message<T: Serialize>(
    stdin: &SharedStdin,
    message: &T,
    stopped: &AtomicBool,
) -> Result<(), AcpRuntimeError> {
    if stopped.load(Ordering::SeqCst) {
        return Err(AcpRuntimeError::Stopped);
    }
    let mut line = serde_json::to_vec(message).map_err(|_| AcpRuntimeError::SerializeFailed)?;
    line.push(b'\n');
    let mut guard = stdin.lock().await;
    let stdin = guard.as_mut().ok_or(AcpRuntimeError::ProcessExited)?;
    stdin
        .write_all(&line)
        .await
        .map_err(|error| AcpRuntimeError::WriteFailed(sanitize_diagnostic(&error.to_string())))?;
    stdin
        .flush()
        .await
        .map_err(|error| AcpRuntimeError::WriteFailed(sanitize_diagnostic(&error.to_string())))
}

fn spawn_stdout_reader(
    stdout: tokio::process::ChildStdout,
    stdin: SharedStdin,
    pending: PendingMap,
    events: broadcast::Sender<AcpRuntimeEvent>,
    stopped: Arc<AtomicBool>,
    unknown_notifications: Arc<AtomicU64>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match parse_incoming_line(line.trim()) {
                        Ok(AcpIncomingMessage::Response { id, result }) => {
                            if let Some(request) = lock_unpoisoned(&pending).remove(&id) {
                                let _ = request.sender.send(Ok(result));
                            }
                        }
                        Ok(AcpIncomingMessage::ErrorResponse { id, error }) => {
                            let runtime_error = AcpRuntimeError::Rpc {
                                code: error.code,
                                message: sanitize_diagnostic(&error.message),
                            };
                            if let Some(id) = id {
                                if let Some(request) = lock_unpoisoned(&pending).remove(&id) {
                                    let _ = request.sender.send(Err(runtime_error));
                                }
                            } else {
                                let _ = events.send(AcpRuntimeEvent::ProtocolWarning {
                                    message: runtime_error.to_string(),
                                });
                            }
                        }
                        Ok(AcpIncomingMessage::Notification { method, params }) => {
                            if method == METHOD_SESSION_UPDATE {
                                if let Some(update) = parse_session_update(&params) {
                                    let _ = events.send(AcpRuntimeEvent::SessionUpdate(update));
                                } else {
                                    let _ = events.send(AcpRuntimeEvent::ProtocolWarning {
                                        message: "ignored malformed ACP session/update".into(),
                                    });
                                }
                            } else {
                                unknown_notifications.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Ok(AcpIncomingMessage::Request { id, .. }) => {
                            let response = json!({
                                "jsonrpc": protocol::JSON_RPC_VERSION,
                                "id": id,
                                "error": {
                                    "code": -32601,
                                    "message": "Method not supported by Taomni ACP client",
                                },
                            });
                            let _ = write_message(&stdin, &response, &stopped).await;
                        }
                        Err(error) => {
                            let _ = events.send(AcpRuntimeEvent::ProtocolWarning {
                                message: error.to_string(),
                            });
                        }
                    }
                }
                Ok(None) | Err(_) => {
                    stopped.store(true, Ordering::SeqCst);
                    fail_pending(&pending, AcpRuntimeError::ProcessExited);
                    let _ = events.send(AcpRuntimeEvent::Closed);
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(
    stderr: tokio::process::ChildStderr,
    buffer: Arc<Mutex<String>>,
    limit: usize,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let sanitized = sanitize_diagnostic(&line);
            let mut buffer = buffer.lock().await;
            append_bounded(&mut buffer, &sanitized, limit);
            append_bounded(&mut buffer, "\n", limit);
        }
    });
}

fn fail_pending(pending: &PendingMap, error: AcpRuntimeError) {
    for (_, request) in lock_unpoisoned(pending).drain() {
        let _ = request.sender.send(Err(error.clone()));
    }
}

fn lock_unpoisoned<T>(mutex: &StdMutex<T>) -> StdMutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn append_bounded(buffer: &mut String, value: &str, limit: usize) {
    buffer.push_str(value);
    if buffer.len() <= limit {
        return;
    }
    let mut start = buffer.len().saturating_sub(limit);
    while start < buffer.len() && !buffer.is_char_boundary(start) {
        start += 1;
    }
    buffer.drain(..start);
}

fn sanitize_diagnostic(value: &str) -> String {
    static JSON_SECRET: OnceLock<Regex> = OnceLock::new();
    static URL_USERINFO: OnceLock<Regex> = OnceLock::new();
    let (redacted, _) = crate::chat::redact::redact(value);
    let redacted = JSON_SECRET
        .get_or_init(|| {
            Regex::new(
                r#"(?i)("(?:password|passwd|pwd|token|api[_-]?key|secret|authorization)"\s*:\s*")[^"]*"#,
            )
            .expect("valid ACP JSON secret regex")
        })
        .replace_all(&redacted, "$1[REDACTED]")
        .into_owned();
    let redacted = URL_USERINFO
        .get_or_init(|| {
            Regex::new(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@")
                .expect("valid ACP URL credential regex")
        })
        .replace_all(&redacted, "$1[REDACTED]@")
        .into_owned();
    protocol::truncate_display_text(&redacted, 1000)
}

fn truncate_method(method: &str) -> String {
    protocol::truncate_display_text(method, 120)
}

fn no_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_config_debug_omits_environment_values() {
        let config = AcpProcessConfig::new("agent", vec!["stdio".into()])
            .with_env("API_KEY", "must-not-appear");
        let debug = format!("{config:?}");
        assert!(debug.contains("API_KEY"));
        assert!(!debug.contains("must-not-appear"));
    }

    #[test]
    fn diagnostic_buffer_is_bounded_and_utf8_safe() {
        let mut buffer = String::new();
        append_bounded(&mut buffer, "123456é", 5);
        assert!(buffer.is_char_boundary(0));
        assert!(buffer.len() <= 5);
        assert!(buffer.ends_with('é'));
    }

    #[test]
    fn diagnostics_redact_json_secrets_and_proxy_credentials() {
        let value = sanitize_diagnostic(
            r#"{"api_key":"super-secret","proxy":"http://user:pass@example.test"}"#,
        );
        assert!(!value.contains("super-secret"));
        assert!(!value.contains("user:pass"));
        assert!(value.contains("[REDACTED]"));
    }
}
