use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::RwLock;

use crate::agent::cc_bridge::process::CcProcess;
use crate::ai::AppAiCtx;
use crate::database::DbSession;
use crate::filebrowser::sftp::ActiveSftp;
use crate::filebrowser::transfer::TransferHandle;
use crate::hbase::HBaseSession;
use crate::lanchat::LanChatState;
use crate::objectstorage::ObjectStorageSession;
use crate::rdp::ws::RdpSession;
use crate::servers::ServerRegistry;
use crate::terminal::{ActiveTerminal, TerminalOutputChannel};
use crate::tunnel::TunnelRegistry;
use crate::vault::Vault;
use crate::vnc::ws::VncSession;

pub struct WriteStreamHandle {
    pub path: PathBuf,
    pub file: std::fs::File,
}

pub struct ReadStreamHandle {
    pub file: std::fs::File,
}

/// In-flight keyboard-interactive (MFA/OTP) auth round. The SSH connect task
/// registers a oneshot sender here keyed by a per-round request id, emits a
/// prompt event to the frontend, then awaits the user's answers on the
/// receiver. `submit_ssh_auth_response` looks the sender up and delivers the
/// responses (or `None` if the user cancelled).
pub type SshAuthResponder = tokio::sync::oneshot::Sender<Option<Vec<String>>>;

/// Outcome the frontend returns for a Claude Code *side-effect* tool call that
/// the in-app MCP server dispatched to it (`run_in_terminal`, `sftp_upload`,
/// `switch_tab`, …). The MCP tool handler registers a oneshot sender keyed by a
/// per-call id, emits an `agent-cc-tool` event, then blocks on the receiver
/// until `cc_resolve_tool_call` delivers this outcome (D2 hybrid model — the
/// human is naturally in the loop because the frontend performs the effect).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CcToolOutcome {
    pub ok: bool,
    pub output: String,
}

pub type CcToolResponder = tokio::sync::oneshot::Sender<CcToolOutcome>;

/// Human decision for a Claude Code permission prompt (HITL, Phase 2). The
/// `permission_prompt` MCP tool registers a oneshot keyed by a per-call id,
/// emits `agent-cc-permission`, and blocks until `cc_resolve_permission`
/// delivers the user's choice from the ActionCard.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CcPermissionDecision {
    Allow,
    AllowSession,
    Deny,
}

pub type CcPermissionResponder = tokio::sync::oneshot::Sender<CcPermissionDecision>;

pub struct AppState {
    pub terminals: Arc<RwLock<HashMap<String, ActiveTerminal>>>,
    pub terminal_outputs: Arc<Mutex<HashMap<String, Vec<TerminalOutputChannel>>>>,
    pub sftp_sessions: Arc<RwLock<HashMap<String, Arc<ActiveSftp>>>>,
    pub transfers: Arc<RwLock<HashMap<String, Arc<TransferHandle>>>>,
    pub tunnels: Arc<TunnelRegistry>,
    pub servers: Arc<ServerRegistry>,
    pub vnc_sessions: Arc<RwLock<HashMap<String, VncSession>>>,
    pub rdp_sessions: Arc<RwLock<HashMap<String, RdpSession>>>,
    /// Live database client connections (MySQL/PostgreSQL/ClickHouse/Redis),
    /// keyed by session id. Each `DbSession` wraps the per-engine connection
    /// handle plus a cancellation token for in-flight queries.
    pub db_connections: Arc<RwLock<HashMap<String, Arc<DbSession>>>>,
    /// Live JVM-free HBase shell sessions over HBase REST/Stargate.
    pub hbase_sessions: Arc<RwLock<HashMap<String, Arc<HBaseSession>>>>,
    /// Live object-storage connections (S3 / S3-compatible / Azure Blob),
    /// keyed by session id. Each holds the per-engine client handle plus a
    /// cancellation token for in-flight list/transfer operations.
    pub oss_sessions: Arc<RwLock<HashMap<String, Arc<ObjectStorageSession>>>>,
    pub read_handles: Arc<Mutex<HashMap<String, ReadStreamHandle>>>,
    pub write_handles: Arc<Mutex<HashMap<String, WriteStreamHandle>>>,
    /// Pending keyboard-interactive auth rounds, keyed by request id. See
    /// [`SshAuthResponder`].
    pub ssh_auth_responders: Arc<Mutex<HashMap<String, SshAuthResponder>>>,
    pub clipboard: Arc<Mutex<Option<arboard::Clipboard>>>,
    pub db: Mutex<rusqlite::Connection>,
    pub vault: Arc<Vault>,
    /// Per-thread Claude Code process registry (v2.6).
    pub cc_processes: tokio::sync::Mutex<HashMap<String, Arc<CcProcess>>>,
    /// Pending CC side-effect tool calls awaiting frontend execution, keyed by
    /// per-call id. See [`CcToolResponder`].
    pub cc_pending_tool_calls: Arc<Mutex<HashMap<String, CcToolResponder>>>,
    /// Pending CC permission prompts awaiting a human decision, keyed by
    /// per-call id. See [`CcPermissionResponder`].
    pub cc_pending_permissions: Arc<Mutex<HashMap<String, CcPermissionResponder>>>,
    /// Per-thread captured-command store (方案4). Holds the full stdout/stderr
    /// of `run_captured` runs (B path: Taomni-local files) so CC can grep/page
    /// large output without dumping it into context. Reduction happens here.
    pub captures: Arc<crate::agent::capture::CaptureRegistry>,
    /// Cancel handles for in-flight captures, keyed by capture id. Firing the
    /// `Notify` drops the SSH exec channel / kills the local child.
    pub cc_capture_cancels: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    /// Last working directory reported for a CC thread (filled each turn from
    /// `ChatSendRequest.cwd`). The B executor bridges it into `run_captured`
    /// (`cd <cwd> && …`) since an MCP tool call has no per-turn cwd of its own.
    pub cc_thread_cwd: Arc<Mutex<HashMap<String, String>>>,
    /// Live DB connection id a CC thread is bound to (Phase 6). The runtime key
    /// for `db_connections` is generated in the frontend (`createRuntimeDbSessionId`)
    /// and isn't derivable backend-side, so the frontend bridges it over each
    /// turn via `ChatSendRequest.bound_db_connection_id`. The SQL/Redis MCP
    /// handlers resolve their bound connection from here (CC never names a
    /// connection id, so this is the only target — scope-safe by construction).
    pub cc_db_bindings: Arc<RwLock<HashMap<String, String>>>,
    /// Top-level AI context — holds AsrManager + LlmRouter.
    /// Wrapped in RwLock so save_ai_config can hot-rebuild the router.
    pub ai_ctx: Arc<RwLock<AppAiCtx>>,
    /// Decentralized LAN messenger (LanChat) runtime state. Distinct from the
    /// AI-assistant `chat`/`voice` modules. Holds node identity, peer roster,
    /// and the lanchat.sqlite path; populated by the lanchat background service.
    pub lanchat: Arc<LanChatState>,
}

impl AppState {
    pub fn new(
        db: rusqlite::Connection,
        vault: Arc<Vault>,
        ai_ctx: AppAiCtx,
        lanchat: Arc<LanChatState>,
    ) -> Self {
        Self {
            terminals: Arc::new(RwLock::new(HashMap::new())),
            terminal_outputs: Arc::new(Mutex::new(HashMap::new())),
            sftp_sessions: Arc::new(RwLock::new(HashMap::new())),
            transfers: Arc::new(RwLock::new(HashMap::new())),
            tunnels: Arc::new(TunnelRegistry::new()),
            servers: Arc::new(ServerRegistry::new()),
            vnc_sessions: Arc::new(RwLock::new(HashMap::new())),
            rdp_sessions: Arc::new(RwLock::new(HashMap::new())),
            db_connections: Arc::new(RwLock::new(HashMap::new())),
            hbase_sessions: Arc::new(RwLock::new(HashMap::new())),
            oss_sessions: Arc::new(RwLock::new(HashMap::new())),
            read_handles: Arc::new(Mutex::new(HashMap::new())),
            write_handles: Arc::new(Mutex::new(HashMap::new())),
            ssh_auth_responders: Arc::new(Mutex::new(HashMap::new())),
            clipboard: Arc::new(Mutex::new(None)),
            db: Mutex::new(db),
            vault,
            cc_processes: tokio::sync::Mutex::new(HashMap::new()),
            cc_pending_tool_calls: Arc::new(Mutex::new(HashMap::new())),
            cc_pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            captures: Arc::new(crate::agent::capture::CaptureRegistry::new(
                std::env::temp_dir().join("taomni-cc-captures"),
            )),
            cc_capture_cancels: Arc::new(Mutex::new(HashMap::new())),
            cc_thread_cwd: Arc::new(Mutex::new(HashMap::new())),
            cc_db_bindings: Arc::new(RwLock::new(HashMap::new())),
            ai_ctx: Arc::new(RwLock::new(ai_ctx)),
            lanchat,
        }
    }
}
