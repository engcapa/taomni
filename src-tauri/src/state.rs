mod domains;
pub use domains::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::RwLock;

use crate::agent::acp_bridge::{AcpProcess, AcpThreadProcess};
use crate::agent::cc_bridge::process::CcProcess;
use crate::agent::codex_bridge::process::CodexAppServer;
use crate::ai::AppAiCtx;
use crate::chat::run::ChatRunRegistry;
use crate::database::DbSession;
use crate::filebrowser::sftp::ActiveSftp;
use crate::filebrowser::transfer::TransferHandle;
use crate::hbase::HBaseSession;
use crate::lanchat::LanChatState;
use crate::lsp::LspManager;
use crate::mail::MailImapPool;
use crate::objectstorage::ObjectStorageSession;
use crate::rdp::ws::RdpSession;
use crate::sdk::SdkManager;
use crate::servers::ServerRegistry;
use crate::sockscap::SocksCapRuntime;
use crate::terminal::{ActiveTerminal, TerminalOutputSubscriber};
use crate::tunnel::TunnelRegistry;
use crate::vault::Vault;
use crate::vnc::ws::VncSession;

pub type MailDbHandle = Arc<crate::mail::coordination::MailDatabase>;

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
    pub tunnels: Arc<TunnelRegistry>,
    /// OS-level SocksCap engine (rules/egress now; capture in later phases).
    pub sockscap: Arc<SocksCapRuntime>,
    pub servers: Arc<ServerRegistry>,
    pub clipboard: Arc<Mutex<Option<arboard::Clipboard>>>,
    pub db: Mutex<rusqlite::Connection>,
    /// Dedicated connection to the standalone Tao Notes database (`notes.db`),
    /// kept separate from `taomni.db` so note storage can evolve independently.
    pub notes_db: Mutex<rusqlite::Connection>,
    /// MFA authenticator store (`mfa.db`, opened lazily on first MFA use).
    pub mfa: Arc<crate::mfa::store::MfaStore>,
    pub vault: Arc<Vault>,
    /// Top-level AI context — holds AsrManager + LlmRouter.
    /// Wrapped in RwLock so save_ai_config can hot-rebuild the router.
    pub ai_ctx: Arc<RwLock<AppAiCtx>>,
    pub opencode_go_catalog: Arc<crate::llm::opencode_go::catalog::CatalogService>,
    /// Decentralized LAN messenger (LanChat) runtime state. Distinct from the
    /// AI-assistant `chat`/`voice` modules. Holds node identity, peer roster,
    /// and the lanchat.sqlite path; populated by the lanchat background service.
    pub lanchat: Arc<LanChatState>,
    pub workspace: WorkspaceRuntime,
    pub mail: MailRuntime,
    pub terminal: TerminalRuntime,
    pub files: FileRuntime,
    pub remote_desktop: RemoteDesktopRuntime,
    pub database: DatabaseRuntime,
    pub agent: AgentRuntime,
}

impl AppState {
    pub fn new(
        db: rusqlite::Connection,
        notes_db: rusqlite::Connection,
        mfa: Arc<crate::mfa::store::MfaStore>,
        mail_db_dir: PathBuf,
        vault: Arc<Vault>,
        ai_ctx: AppAiCtx,
        lanchat: Arc<LanChatState>,
    ) -> Self {
        let sdk = Arc::new(SdkManager::load(crate::sdk::default_sdk_registry_path()));
        // Build the LSP manager first so the DAP manager can register the Java
        // debug adapter (D2), which drives jdtls via this handle.
        let lsp = Arc::new(LspManager::with_sdk(sdk.clone()));
        let dap = Arc::new(crate::dap::DapManager::with_lsp(lsp.clone()));
        Self {
            tunnels: Arc::new(TunnelRegistry::new()),
            sockscap: Arc::new(SocksCapRuntime::new()),
            servers: Arc::new(ServerRegistry::new()),
            clipboard: Arc::new(Mutex::new(None)),
            db: Mutex::new(db),
            notes_db: Mutex::new(notes_db),
            mfa,
            vault,
            ai_ctx: Arc::new(RwLock::new(ai_ctx)),
            opencode_go_catalog: crate::llm::opencode_go::catalog::shared_catalog(),
            lanchat,
            workspace: WorkspaceRuntime { lsp, dap, sdk },
            mail: MailRuntime {
                mail_db_dir,
                mail_dbs: Arc::new(Mutex::new(HashMap::new())),
                mail_archive: crate::mail::archive::ArchiveManager::default(),
                mail_imap_pool: Arc::new(MailImapPool::new()),
            },
            terminal: TerminalRuntime {
                terminals: Arc::new(RwLock::new(HashMap::new())),
                terminal_outputs: Arc::new(Mutex::new(HashMap::new())),
                ssh_auth_responders: Arc::new(Mutex::new(HashMap::new())),
                local_directory_runtime: Arc::new(Mutex::new(HashMap::new())),
            },
            files: FileRuntime {
                sftp_sessions: Arc::new(RwLock::new(HashMap::new())),
                transfers: Arc::new(RwLock::new(HashMap::new())),
                oss_sessions: Arc::new(RwLock::new(HashMap::new())),
                read_handles: Arc::new(Mutex::new(HashMap::new())),
                write_handles: Arc::new(Mutex::new(HashMap::new())),
            },
            remote_desktop: RemoteDesktopRuntime {
                vnc_sessions: Arc::new(RwLock::new(HashMap::new())),
                vnc_detach_claims: Arc::new(RwLock::new(HashMap::new())),
                rdp_sessions: Arc::new(RwLock::new(HashMap::new())),
            },
            database: DatabaseRuntime {
                db_connections: Arc::new(RwLock::new(HashMap::new())),
                hbase_sessions: Arc::new(RwLock::new(HashMap::new())),
            },
            agent: AgentRuntime {
                cc_processes: tokio::sync::Mutex::new(HashMap::new()),
                codex_processes: tokio::sync::Mutex::new(HashMap::new()),
                acp_processes: tokio::sync::Mutex::new(HashMap::new()),
                acp_media_processes: tokio::sync::Mutex::new(HashMap::new()),
                chat_runs: Arc::new(ChatRunRegistry::new(HashMap::new())),
                cc_pending_tool_calls: Arc::new(Mutex::new(HashMap::new())),
                cc_pending_permissions: Arc::new(Mutex::new(HashMap::new())),
                captures: Arc::new(crate::agent::capture::CaptureRegistry::new(
                    std::env::temp_dir().join("taomni-cc-captures"),
                )),
                cc_capture_cancels: Arc::new(Mutex::new(HashMap::new())),
                agent_thread_cwd: Arc::new(Mutex::new(HashMap::new())),
                cc_tab_sessions: Arc::new(Mutex::new(HashMap::new())),
                agent_db_bindings: Arc::new(RwLock::new(HashMap::new())),
                agent_db_selected_objects: Arc::new(RwLock::new(HashMap::new())),
                agent_code_workspaces: Arc::new(RwLock::new(HashMap::new())),
            },
        }
    }

    /// Root of the per-account mail caches (`<app_data>/mail-cache`).
    pub fn mail_cache_root(&self) -> &std::path::Path {
        &self.mail.mail_db_dir
    }

    pub fn mail_db(&self, account_id: &str) -> Result<MailDbHandle, String> {
        let stem = mail_db_file_stem(account_id);
        let mut dbs = self.mail.mail_dbs.lock().map_err(|e| e.to_string())?;
        if let Some(db) = dbs.get(&stem) {
            return Ok(Arc::clone(db));
        }

        let configured = {
            let db = self.db.lock().map_err(|e| e.to_string())?;
            crate::session::db::get_session(&db, account_id)
                .ok()
                .map(|session| {
                    crate::mail::storage::configured_directory(
                        &session.options_json,
                        &self.mail.mail_db_dir,
                    )
                })
                .transpose()?
                .unwrap_or_else(|| self.mail.mail_db_dir.clone())
        };
        let path = configured.join(format!("{stem}.db"));
        let handle = Arc::new(crate::mail::coordination::MailDatabase::new(path));
        dbs.insert(stem, Arc::clone(&handle));
        Ok(handle)
    }
}

pub(crate) fn mail_db_file_stem(account_id: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut cleaned = account_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if cleaned.is_empty() {
        cleaned = "mail".into();
    }
    cleaned = cleaned.chars().take(80).collect();

    let digest = Sha256::digest(account_id.as_bytes());
    let digest_hex = hex::encode(digest);
    format!("{cleaned}-{}", &digest_hex[..16])
}
