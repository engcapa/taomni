use super::adapter::ConfiguredDebugAdapter;
use super::adapter::DebugAdapterRegistry;
use super::codec::encode_message;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;
use tokio::sync::Mutex;
use tokio::sync::oneshot;

pub(super) type PendingResponses = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// How long `initialize` may take before the session is reported as unreachable.
pub(super) const INITIALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Grace period for a graceful `terminate` before falling back to `disconnect`.
pub(super) const TERMINATE_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Upper bound on an ordinary DAP request/response round-trip. A wedged adapter
/// that connected but stopped answering must not leave a command (setBreakpoints,
/// stackTrace, evaluate…) pending forever — the UI would sit "running" with no
/// error. Generous so a slow-but-live adapter is not cut off; `launch` is fired
/// fire-and-forget (its response legitimately trails configurationDone) so this
/// does not apply to it.
pub(super) const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// A live debug session. Holds the write half + pending-response correlation +
/// child handle; **no `AppHandle`** — the reader task owns a cloned handle so this
/// struct stays out of the AppState-reachable AppHandle trap (see M7-C).
pub struct DapSession {
    /// DAP `seq` counter (starts at 1; every message we send gets the next).
    pub(super) next_seq: AtomicI64,
    pub(super) pending: PendingResponses,
    pub(super) writer: Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    /// Spawned adapter process for `Stdio` transport (kept so drop kills it).
    pub(super) child: Mutex<Option<tokio::process::Child>>,
    /// Adapter capabilities from the `initialize` response.
    pub(super) capabilities: Mutex<Value>,
}

impl DapSession {
    pub(super) fn next_seq(&self) -> i64 {
        self.next_seq.fetch_add(1, Ordering::SeqCst)
    }

    /// Reply to an adapter-initiated (reverse) request. Every reverse request
    /// MUST get a response or the adapter blocks waiting for one, so the reader
    /// answers ones the kernel cannot serve with a failure (see
    /// [`reverse_response`]).
    pub async fn respond(&self, response: &Value) -> Result<(), String> {
        let mut response = response.clone();
        response["seq"] = json!(self.next_seq());
        self.write_message(&response).await
    }

    /// Send a DAP request and await its response (correlated by `seq`).
    pub async fn request(&self, command: &str, arguments: Value) -> Result<Value, String> {
        let seq = self.next_seq();
        let message = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": normalize_request_arguments(arguments),
        });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(seq, tx);
        self.write_message(&message).await?;
        // Bound the wait: a wedged adapter must not hang the command forever.
        // On timeout, drop the pending slot so a late reply is discarded cleanly.
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(result) => result.map_err(|_| "DAP session closed before response".to_string())?,
            Err(_) => {
                self.pending.lock().await.remove(&seq);
                Err(format!(
                    "debug adapter did not answer `{command}` within {}s",
                    REQUEST_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// Fire a DAP request without awaiting a response (e.g. `disconnect`).
    pub async fn notify(&self, command: &str, arguments: Value) -> Result<(), String> {
        let seq = self.next_seq();
        self.write_message(&json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": normalize_request_arguments(arguments),
        }))
        .await
    }

    pub(super) async fn write_message(&self, message: &Value) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let framed = encode_message(message);
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&framed)
            .await
            .map_err(|e| format!("DAP write failed: {e}"))?;
        writer
            .flush()
            .await
            .map_err(|e| format!("DAP flush failed: {e}"))
    }
}

/// DAP declares request arguments optional, but some adapters deserialize the
/// field directly as an object. In particular java-debug rejects an explicit
/// JSON `null` with `Expected JsonObject but was JsonNull`, closes the socket,
/// and tears down an otherwise successfully launched debuggee. Tauri maps an
/// omitted/`null` command argument to `Value::Null`, so normalize it at the
/// protocol boundary for every request (`configurationDone`, `threads`, ...).
pub(super) fn normalize_request_arguments(arguments: Value) -> Value {
    if arguments.is_null() {
        json!({})
    } else {
        arguments
    }
}

/// Holds live sessions + the adapter registry. Lives in `AppState`; holds **no
/// `AppHandle`** (event emission uses a handle cloned into the reader task).
pub struct DapManager {
    pub(super) sessions: Mutex<HashMap<String, Arc<DapSession>>>,
    pub(super) registry: DebugAdapterRegistry,
}

impl Default for DapManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            // D1 ships an empty registry; D2 registers the Java adapter here.
            registry: DebugAdapterRegistry::new(),
        }
    }
}

impl DapManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a manager with the language adapters that need `LspManager` access
    /// registered (D2: Java, via jdtls executeCommand). Used from `AppState::new`.
    pub fn with_lsp(lsp: Arc<crate::lsp::LspManager>) -> Self {
        let mut registry = DebugAdapterRegistry::new();
        registry.register(Arc::new(crate::java_debug_adapter::JavaDebugAdapter::new(
            lsp,
        )));
        for adapter_id in ["lldb", "delve", "python", "node", "coreclr"] {
            registry.register(Arc::new(ConfiguredDebugAdapter::new(adapter_id)));
        }
        Self {
            sessions: Mutex::new(HashMap::new()),
            registry,
        }
    }

    pub(super) async fn insert(&self, session_id: String, session: Arc<DapSession>) {
        self.sessions.lock().await.insert(session_id, session);
    }

    pub(super) async fn get(&self, session_id: &str) -> Option<Arc<DapSession>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    pub(super) async fn remove(&self, session_id: &str) -> Option<Arc<DapSession>> {
        self.sessions.lock().await.remove(session_id)
    }
}
