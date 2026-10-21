use super::*;

/// Runtime ownership for the workspace domain.
pub struct WorkspaceRuntime {
    /// Local language-server process registry for code-workspace editor tabs.
    pub lsp: Arc<LspManager>,
    /// Debug Adapter Protocol sessions + adapter registry (M8 D1).
    pub dap: Arc<crate::dap::DapManager>,
    /// Versioned SDK installations, defaults and per-workspace manual bindings.
    pub sdk: Arc<SdkManager>,
}

/// Runtime ownership for the mail domain.
pub struct MailRuntime {
    /// Directory containing one SQLite cache database per saved or transient mail
    /// session. Mail caches are intentionally isolated from `taomni.db`, and
    /// from each other, so mailbox refresh writes cannot block session CRUD.
    pub(super) mail_db_dir: PathBuf,
    pub(super) mail_dbs: Arc<Mutex<HashMap<String, MailDbHandle>>>,
    /// Live IMAP sessions keyed by mail account/session id. Reuses TCP/TLS/auth
    /// and any session-level proxy forwarder across mail commands. Never routes
    /// through the app global proxy.
    pub mail_imap_pool: Arc<MailImapPool>,
    pub mail_archive: crate::mail::archive::ArchiveManager,
}

/// Runtime ownership for the terminal domain.
pub struct TerminalRuntime {
    pub terminals: Arc<RwLock<HashMap<String, ActiveTerminal>>>,
    pub terminal_outputs: Arc<Mutex<HashMap<String, Vec<TerminalOutputSubscriber>>>>,
    /// Pending keyboard-interactive auth rounds, keyed by request id. See
    /// [`SshAuthResponder`].
    pub ssh_auth_responders: Arc<Mutex<HashMap<String, SshAuthResponder>>>,
    /// Per-runtime local-directory dedup state (design §4.1.5): the last
    /// confirmed directory path key reported by each live native-local
    /// terminal, keyed by backend session id. `close_terminal` clears it so
    /// late OSC reports after close can never write.
    pub local_directory_runtime: Arc<Mutex<HashMap<String, String>>>,
}

/// Runtime ownership for the files domain.
pub struct FileRuntime {
    pub sftp_sessions: Arc<RwLock<HashMap<String, Arc<ActiveSftp>>>>,
    pub transfers: Arc<RwLock<HashMap<String, Arc<TransferHandle>>>>,
    /// Live object-storage connections (S3 / S3-compatible / Azure Blob),
    /// keyed by session id. Each holds the per-engine client handle plus a
    /// cancellation token for in-flight list/transfer operations.
    pub oss_sessions: Arc<RwLock<HashMap<String, Arc<ObjectStorageSession>>>>,
    pub read_handles: Arc<Mutex<HashMap<String, ReadStreamHandle>>>,
    pub write_handles: Arc<Mutex<HashMap<String, WriteStreamHandle>>>,
}

/// Runtime ownership for the remote desktop domain.
pub struct RemoteDesktopRuntime {
    pub vnc_sessions: Arc<RwLock<HashMap<String, VncSession>>>,
    pub vnc_detach_claims: Arc<RwLock<HashMap<String, crate::vnc::VncDetachClaim>>>,
    pub rdp_sessions: Arc<RwLock<HashMap<String, RdpSession>>>,
}

/// Runtime ownership for the database domain.
pub struct DatabaseRuntime {
    /// Live database client connections (MySQL/PostgreSQL/Oracle/SQL Server/StarRocks/ClickHouse/Redis),
    /// keyed by session id. Each `DbSession` wraps the per-engine connection
    /// handle plus a cancellation token for in-flight queries.
    pub db_connections: Arc<RwLock<HashMap<String, Arc<DbSession>>>>,
    /// Live JVM-free HBase shell sessions over HBase REST/Stargate.
    pub hbase_sessions: Arc<RwLock<HashMap<String, Arc<HBaseSession>>>>,
}

/// Runtime ownership for the agent domain.
pub struct AgentRuntime {
    /// Per-thread Claude Code process registry (v2.6).
    pub cc_processes: tokio::sync::Mutex<HashMap<String, Arc<CcProcess>>>,
    /// Per-thread Codex app-server registry.
    pub codex_processes: tokio::sync::Mutex<HashMap<String, Arc<CodexAppServer>>>,
    /// Per-thread ACP process registry, isolated from the legacy bridges.
    pub acp_processes: tokio::sync::Mutex<HashMap<String, Arc<AcpThreadProcess>>>,
    /// Short-lived ACP subprocesses used for native image/video generation.
    /// They participate in the same permission-gate and stop lifecycle as a
    /// normal ACP chat turn, but do not own MCP credentials or persisted ACP
    /// sessions.
    pub acp_media_processes: tokio::sync::Mutex<HashMap<String, Arc<AcpProcess>>>,
    /// Provider-agnostic stop handles for in-flight chat turns, keyed by thread_id.
    pub chat_runs: Arc<ChatRunRegistry>,
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
    /// Last working directory reported for an agent thread (filled each turn from
    /// `ChatSendRequest.cwd`). The B executor bridges it into `run_captured`
    /// (`cd <cwd> && …`) since an MCP tool call has no per-turn cwd of its own.
    pub agent_thread_cwd: Arc<Mutex<HashMap<String, String>>>,
    /// Maps a terminal *tab id* (the caller-facing id CC's tools see — equal to
    /// `chat thread.linked_session_id` / the token's `allowed_session_id`) to the
    /// *backend terminal session id* used as the `terminals` map key (a fresh
    /// `crypto.randomUUID()` per connection, distinct from the tab id). The
    /// frontend reports this as terminals connect/disconnect (`cc_track_terminal`
    /// / `cc_untrack_terminal`), so backend-side CC tools (`run_captured` /
    /// `read_capture`) can resolve the live terminal that `run_in_terminal`
    /// reaches indirectly through the frontend registry. Refreshed on reconnect.
    pub cc_tab_sessions: Arc<Mutex<HashMap<String, String>>>,
    /// Live DB connection id an agent thread is bound to (Phase 6). The runtime key
    /// for `db_connections` is generated in the frontend (`createRuntimeDbSessionId`)
    /// and isn't derivable backend-side, so the frontend bridges it over each
    /// turn via `ChatSendRequest.bound_db_connection_id`. The SQL/Redis MCP
    /// handlers resolve their bound connection from here (the model never names a
    /// connection id, so this is the only target — scope-safe by construction).
    pub agent_db_bindings: Arc<RwLock<HashMap<String, String>>>,
    /// Current objects selected in the bound DB tab's schema tree, bridged
    /// per chat turn just like `agent_db_bindings`. SQL MCP tools use this to
    /// resolve user phrases such as "selected tables" without reading frontend
    /// UI state directly. The list can include non-queryable object kinds; SQL
    /// MCP tools expose a queryable subset for SELECT workflows.
    pub agent_db_selected_objects:
        Arc<RwLock<HashMap<String, Vec<crate::agent::context::AgentDbSelectedObject>>>>,
    /// Current code workspace bound to an agent thread, bridged per chat turn.
    /// This gives Codex/Claude sidecars a stable repo/file context without
    /// reading frontend UI state directly.
    pub agent_code_workspaces:
        Arc<RwLock<HashMap<String, crate::agent::context::AgentCodeWorkspace>>>,
}
