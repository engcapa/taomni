use super::protocol::{
    self, ACP_PROTOCOL_VERSION, AcpAgentInfo, AcpIncomingMessage, AcpNotification,
    AcpPermissionOption, AcpPermissionRequest, AcpPromptResult, AcpRequest, AcpRequestId,
    AcpResourceLink, METHOD_SESSION_REQUEST_PERMISSION, METHOD_SESSION_UPDATE,
    authenticate_request, cancel_notification, initialize_request, load_session_request,
    new_session_request, parse_incoming_line, parse_initialize_result, parse_permission_request,
    parse_prompt_result, parse_session_update, permission_cancelled_response,
    permission_selected_response, prompt_request, prompt_with_resource_links_request,
    session_id_from_response,
};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard as StdMutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, broadcast, oneshot, watch};

pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_STDERR_LIMIT: usize = 8 * 1024;
const EVENT_CHANNEL_CAPACITY: usize = 256;
/// A local CLI has already made the permission request, so give its JSON-RPC
/// response a brief chance to flush before sending `session/cancel` or closing
/// stdin. This prevents a stop action from looking like a failed tool call.
const PERMISSION_RESPONSE_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

type PendingMap = Arc<StdMutex<HashMap<AcpRequestId, PendingRequest>>>;
type PendingPermissionMap = Arc<StdMutex<HashMap<String, PendingPermission>>>;
type ClosedPermissionSessions = Arc<StdMutex<HashSet<String>>>;
type SharedStdin = Arc<Mutex<Option<ChildStdin>>>;

struct PendingRequest {
    sender: oneshot::Sender<Result<Value, AcpRuntimeError>>,
}

struct PendingPermission {
    session_id: String,
    option_ids: BTreeSet<String>,
    /// `None` means a user decision or a cancellation has already been sent
    /// to the response task. Keep the entry until that task has written the
    /// RPC response so a concurrent stop can wait for the flush.
    sender: Option<oneshot::Sender<AcpPermissionResolution>>,
    completion: Arc<PermissionCompletion>,
}

enum AcpPermissionResolution {
    Selected(String),
    Cancelled,
}

/// A cloneable completion signal for a permission RPC response. A watch
/// channel deliberately retains the completed state for late waiters, unlike
/// a one-shot notification that could race with a concurrent stop.
struct PermissionCompletion {
    sender: watch::Sender<bool>,
}

impl PermissionCompletion {
    fn new() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }

    fn finish(&self) {
        // `send` discards the value when no receiver exists yet. A resolver
        // can start waiting just after the response task finishes, so retain
        // the completed state for that late subscriber.
        let _ = self.sender.send_replace(true);
    }

    async fn wait(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow() {
            return;
        }
        let _ = receiver.changed().await;
    }
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

/// A display-safe ACP permission request ready for Taomni's confirmation UI.
/// The protocol session id and raw tool arguments never leave the ACP runtime.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionPrompt {
    pub call_id: String,
    pub title: String,
    pub kind: String,
    pub options: Vec<AcpPermissionOption>,
}

/// One long-lived ACP agent subprocess. The runtime is intentionally provider
/// neutral; Grok-specific command discovery and authentication selection live
/// in profile configuration, not in the request router.
pub struct AcpProcess {
    /// Opaque per-process identity used only to scope frontend permission
    /// cards. A thread can temporarily have a reusable chat ACP process and
    /// a short-lived media process at the same time.
    permission_owner_id: String,
    child: Mutex<Option<Child>>,
    stdin: SharedStdin,
    pending: PendingMap,
    pending_permissions: PendingPermissionMap,
    /// Serializes permission registration against cancellation/stop. It is
    /// never held while awaiting a human decision.
    permission_registration: Arc<Mutex<()>>,
    /// Sessions whose current prompt has completed or been cancelled. A late
    /// `session/request_permission` for one of these sessions gets the ACP
    /// cancelled outcome directly rather than reviving a stale UI gate.
    closed_permission_sessions: ClosedPermissionSessions,
    accepts_permissions: Arc<AtomicBool>,
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
        let pending_permissions = Arc::new(StdMutex::new(HashMap::new()));
        let permission_registration = Arc::new(Mutex::new(()));
        let closed_permission_sessions = Arc::new(StdMutex::new(HashSet::new()));
        let accepts_permissions = Arc::new(AtomicBool::new(true));
        let permission_owner_id = uuid::Uuid::new_v4().to_string();
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let stopped = Arc::new(AtomicBool::new(false));
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let unknown_notifications = Arc::new(AtomicU64::new(0));

        spawn_stdout_reader(
            stdout,
            stdin.clone(),
            pending.clone(),
            pending_permissions.clone(),
            permission_registration.clone(),
            closed_permission_sessions.clone(),
            accepts_permissions.clone(),
            events.clone(),
            stopped.clone(),
            unknown_notifications.clone(),
            config.request_timeout,
        );
        spawn_stderr_reader(stderr, stderr_buf.clone(), config.stderr_limit);

        Ok(Self {
            permission_owner_id,
            child: Mutex::new(Some(child)),
            stdin,
            pending,
            pending_permissions,
            permission_registration,
            closed_permission_sessions,
            accepts_permissions,
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

    /// Opaque identity for routing this process's permission cards in the UI.
    pub fn permission_owner_id(&self) -> &str {
        &self.permission_owner_id
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
        self.open_permission_session(session_id).await;
        let request = prompt_request(self.allocate_id(), session_id, text);
        let result = self.send_request(request).await;
        // A late native-tool request must never survive beyond its turn. This
        // also makes an agent-side prompt error fail closed instead of leaving
        // a stale approval card in the next chat turn.
        self.cancel_permissions_for_session(session_id).await;
        let result = result?;
        parse_prompt_result(&result).map_err(|error| AcpRuntimeError::Protocol(error.to_string()))
    }

    /// Submit a prompt with standard ACP resource links. Resource links are
    /// intentionally distinct from inline image blocks so callers can support
    /// local-file attachments without claiming an unadvertised image capability.
    pub async fn prompt_with_resource_links(
        &self,
        session_id: &str,
        text: &str,
        resource_links: &[AcpResourceLink],
    ) -> Result<AcpPromptResult, AcpRuntimeError> {
        let _turn = self.begin_turn()?;
        self.open_permission_session(session_id).await;
        let request = prompt_with_resource_links_request(
            self.allocate_id(),
            session_id,
            text,
            resource_links,
        );
        let result = self.send_request(request).await;
        self.cancel_permissions_for_session(session_id).await;
        let result = result?;
        parse_prompt_result(&result).map_err(|error| AcpRuntimeError::Protocol(error.to_string()))
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpRuntimeError> {
        self.cancel_permissions_for_session(session_id).await;
        self.send_notification(cancel_notification(session_id))
            .await
    }

    /// Resolve a permission request previously emitted through
    /// [`AcpRuntimeEvent::PermissionRequest`]. Both the generated call id and
    /// the option id must still match a pending request; callers cannot invent
    /// an approval for a different tool or session.
    pub async fn resolve_permission(
        &self,
        call_id: &str,
        option_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        let completion = {
            let mut pending = lock_unpoisoned(&self.pending_permissions);
            let permission = pending
                .get_mut(call_id)
                .ok_or(AcpRuntimeError::PermissionNotPending)?;
            if !permission.option_ids.contains(option_id) {
                return Err(AcpRuntimeError::PermissionOptionUnavailable);
            }
            let sender = permission
                .sender
                .take()
                .ok_or(AcpRuntimeError::PermissionNotPending)?;
            sender
                .send(AcpPermissionResolution::Selected(option_id.to_string()))
                .map_err(|_| AcpRuntimeError::PermissionNotPending)?;
            permission.completion.clone()
        };
        wait_for_permission_response(&completion).await;
        Ok(())
    }

    /// Cancel one visible native-tool approval card. Unlike selecting a
    /// reject-looking option, this uses ACP's canonical `cancelled` outcome.
    pub async fn cancel_permission(&self, call_id: &str) -> Result<(), AcpRuntimeError> {
        let completion = {
            let mut pending = lock_unpoisoned(&self.pending_permissions);
            let permission = pending
                .get_mut(call_id)
                .ok_or(AcpRuntimeError::PermissionNotPending)?;
            let sender = permission
                .sender
                .take()
                .ok_or(AcpRuntimeError::PermissionNotPending)?;
            sender
                .send(AcpPermissionResolution::Cancelled)
                .map_err(|_| AcpRuntimeError::PermissionNotPending)?;
            permission.completion.clone()
        };
        wait_for_permission_response(&completion).await;
        Ok(())
    }

    /// Send an extension request. This keeps the runtime generic and is useful
    /// for capability-gated ACP additions without weakening inbound security.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, AcpRuntimeError> {
        let request = AcpRequest::new(self.allocate_id(), method, params);
        self.send_request(request).await
    }

    pub async fn stop(&self) {
        // Stop accepting permission requests before draining the current set.
        // Holding the registration lock through the flush means a request that
        // was already being registered is included, while any later request
        // observes the stopped process and fails closed.
        self.accepts_permissions.store(false, Ordering::SeqCst);
        let registration = self.permission_registration.lock().await;
        cancel_all_permissions(&self.pending_permissions).await;
        self.stopped.store(true, Ordering::SeqCst);
        *self.stdin.lock().await = None;
        fail_pending(&self.pending, AcpRuntimeError::Stopped);
        clear_pending_permissions(&self.pending_permissions);
        drop(registration);
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

    async fn open_permission_session(&self, session_id: &str) {
        let _registration = self.permission_registration.lock().await;
        lock_unpoisoned(&self.closed_permission_sessions).remove(session_id);
    }

    fn touch(&self) {
        *lock_unpoisoned(&self.last_active_at) = Instant::now();
    }
}

impl Drop for AcpProcess {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        fail_pending(&self.pending, AcpRuntimeError::Stopped);
        clear_pending_permissions(&self.pending_permissions);
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
    pending_permissions: PendingPermissionMap,
    permission_registration: Arc<Mutex<()>>,
    closed_permission_sessions: ClosedPermissionSessions,
    accepts_permissions: Arc<AtomicBool>,
    events: broadcast::Sender<AcpRuntimeEvent>,
    stopped: Arc<AtomicBool>,
    unknown_notifications: Arc<AtomicU64>,
    permission_timeout: Duration,
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
                        Ok(AcpIncomingMessage::Request { id, method, params }) => {
                            if method == METHOD_SESSION_REQUEST_PERMISSION {
                                match parse_permission_request(&params) {
                                    Ok(request) => {
                                        spawn_permission_response(
                                            id,
                                            request,
                                            stdin.clone(),
                                            pending_permissions.clone(),
                                            permission_registration.clone(),
                                            closed_permission_sessions.clone(),
                                            accepts_permissions.clone(),
                                            events.clone(),
                                            stopped.clone(),
                                            permission_timeout,
                                        )
                                        .await;
                                    }
                                    Err(_) => {
                                        let response = json!({
                                            "jsonrpc": protocol::JSON_RPC_VERSION,
                                            "id": id,
                                            "error": {
                                                "code": -32602,
                                                "message": "Invalid ACP permission request",
                                            },
                                        });
                                        let _ = write_message(&stdin, &response, &stopped).await;
                                        let _ = events.send(AcpRuntimeEvent::ProtocolWarning {
                                            message: "ignored invalid ACP permission request"
                                                .into(),
                                        });
                                    }
                                }
                            } else {
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
                    clear_pending_permissions(&pending_permissions);
                    let _ = events.send(AcpRuntimeEvent::Closed);
                    break;
                }
            }
        }
    });
}

async fn spawn_permission_response(
    id: AcpRequestId,
    request: AcpPermissionRequest,
    stdin: SharedStdin,
    pending_permissions: PendingPermissionMap,
    permission_registration: Arc<Mutex<()>>,
    closed_permission_sessions: ClosedPermissionSessions,
    accepts_permissions: Arc<AtomicBool>,
    events: broadcast::Sender<AcpRuntimeEvent>,
    stopped: Arc<AtomicBool>,
    permission_timeout: Duration,
) {
    let _registration = permission_registration.lock().await;
    if !accepts_permissions.load(Ordering::SeqCst)
        || stopped.load(Ordering::SeqCst)
        || lock_unpoisoned(&closed_permission_sessions).contains(&request.session_id)
    {
        let response = permission_cancelled_response(id);
        let _ = write_message(&stdin, &response, &stopped).await;
        return;
    }

    let call_id = uuid::Uuid::new_v4().to_string();
    let prompt = AcpPermissionPrompt {
        call_id: call_id.clone(),
        title: request.title,
        kind: request.kind,
        options: request.options,
    };
    let option_ids = prompt
        .options
        .iter()
        .map(|option| option.option_id.clone())
        .collect();
    let (sender, receiver) = oneshot::channel();
    let completion = Arc::new(PermissionCompletion::new());
    lock_unpoisoned(&pending_permissions).insert(
        call_id.clone(),
        PendingPermission {
            session_id: request.session_id,
            option_ids,
            sender: Some(sender),
            completion: completion.clone(),
        },
    );
    // A missing UI subscriber must fail closed immediately instead of leaving
    // an agent-side request stuck until the normal timeout elapses.
    let delivered = events
        .send(AcpRuntimeEvent::PermissionRequest(prompt))
        .is_ok();
    if !delivered
        && let Some(sender) = lock_unpoisoned(&pending_permissions)
            .get_mut(&call_id)
            .and_then(|permission| permission.sender.take())
    {
        let _ = sender.send(AcpPermissionResolution::Cancelled);
    }
    drop(_registration);

    tokio::spawn(async move {
        let resolution = if delivered {
            match tokio::time::timeout(permission_timeout, receiver).await {
                Ok(Ok(resolution)) => resolution,
                Ok(Err(_)) | Err(_) => AcpPermissionResolution::Cancelled,
            }
        } else {
            AcpPermissionResolution::Cancelled
        };
        let response = match resolution {
            AcpPermissionResolution::Selected(option_id) => {
                permission_selected_response(id, &option_id)
            }
            AcpPermissionResolution::Cancelled => permission_cancelled_response(id),
        };
        let _ = write_message(&stdin, &response, &stopped).await;
        lock_unpoisoned(&pending_permissions).remove(&call_id);
        let _ = events.send(AcpRuntimeEvent::PermissionResolved { call_id });
        // Wake prompt/cancel/stop callers only after the dismissal event is
        // queued for the current stream receiver. Otherwise a fast turn exit
        // could drop that receiver before the WebView hears to remove its card.
        completion.finish();
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

impl AcpProcess {
    async fn cancel_permissions_for_session(&self, session_id: &str) {
        let registration = self.permission_registration.lock().await;
        lock_unpoisoned(&self.closed_permission_sessions).insert(session_id.to_string());
        let completions = take_permission_cancellations(&self.pending_permissions, |permission| {
            permission.session_id == session_id
        });
        wait_for_permission_responses(&completions).await;
        drop(registration);
    }
}

/// Mark every matching unresolved permission as cancelled and return the
/// response completions for both newly-cancelled and already-selected entries.
/// Keeping selected entries in the list makes stop wait for a click response
/// that is currently flushing to the local CLI.
fn take_permission_cancellations(
    pending_permissions: &PendingPermissionMap,
    matches: impl Fn(&PendingPermission) -> bool,
) -> Vec<Arc<PermissionCompletion>> {
    let mut permissions = lock_unpoisoned(pending_permissions);
    permissions
        .values_mut()
        .filter(|permission| matches(permission))
        .map(|permission| {
            if let Some(sender) = permission.sender.take() {
                let _ = sender.send(AcpPermissionResolution::Cancelled);
            }
            permission.completion.clone()
        })
        .collect()
}

async fn cancel_all_permissions(pending_permissions: &PendingPermissionMap) {
    let completions = take_permission_cancellations(pending_permissions, |_| true);
    wait_for_permission_responses(&completions).await;
}

async fn wait_for_permission_responses(completions: &[Arc<PermissionCompletion>]) {
    if completions.is_empty() {
        return;
    }
    let _ = tokio::time::timeout(PERMISSION_RESPONSE_FLUSH_TIMEOUT, async {
        for completion in completions {
            completion.wait().await;
        }
    })
    .await;
}

async fn wait_for_permission_response(completion: &Arc<PermissionCompletion>) {
    wait_for_permission_responses(std::slice::from_ref(completion)).await;
}

fn clear_pending_permissions(pending_permissions: &PendingPermissionMap) {
    lock_unpoisoned(pending_permissions).clear();
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
