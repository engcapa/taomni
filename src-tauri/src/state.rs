use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::RwLock;

use crate::agent::cc_bridge::process::CcProcess;
use crate::ai::AppAiCtx;
use crate::filebrowser::sftp::ActiveSftp;
use crate::filebrowser::transfer::TransferHandle;
use crate::rdp::ws::RdpSession;
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

pub struct AppState {
    pub terminals: Arc<RwLock<HashMap<String, ActiveTerminal>>>,
    pub terminal_outputs: Arc<Mutex<HashMap<String, Vec<TerminalOutputChannel>>>>,
    pub sftp_sessions: Arc<RwLock<HashMap<String, Arc<ActiveSftp>>>>,
    pub transfers: Arc<RwLock<HashMap<String, Arc<TransferHandle>>>>,
    pub tunnels: Arc<TunnelRegistry>,
    pub vnc_sessions: Arc<RwLock<HashMap<String, VncSession>>>,
    pub rdp_sessions: Arc<RwLock<HashMap<String, RdpSession>>>,
    pub read_handles: Arc<Mutex<HashMap<String, ReadStreamHandle>>>,
    pub write_handles: Arc<Mutex<HashMap<String, WriteStreamHandle>>>,
    pub clipboard: Arc<Mutex<Option<arboard::Clipboard>>>,
    pub db: Mutex<rusqlite::Connection>,
    pub vault: Arc<Vault>,
    /// Per-thread Claude Code process registry (v2.6).
    pub cc_processes: tokio::sync::Mutex<HashMap<String, Arc<CcProcess>>>,
    /// Top-level AI context — holds AsrManager + LlmRouter.
    /// Wrapped in RwLock so save_ai_config can hot-rebuild the router.
    pub ai_ctx: Arc<RwLock<AppAiCtx>>,
}

impl AppState {
    pub fn new(db: rusqlite::Connection, vault: Arc<Vault>, ai_ctx: AppAiCtx) -> Self {
        Self {
            terminals: Arc::new(RwLock::new(HashMap::new())),
            terminal_outputs: Arc::new(Mutex::new(HashMap::new())),
            sftp_sessions: Arc::new(RwLock::new(HashMap::new())),
            transfers: Arc::new(RwLock::new(HashMap::new())),
            tunnels: Arc::new(TunnelRegistry::new()),
            vnc_sessions: Arc::new(RwLock::new(HashMap::new())),
            rdp_sessions: Arc::new(RwLock::new(HashMap::new())),
            read_handles: Arc::new(Mutex::new(HashMap::new())),
            write_handles: Arc::new(Mutex::new(HashMap::new())),
            clipboard: Arc::new(Mutex::new(None)),
            db: Mutex::new(db),
            vault,
            cc_processes: tokio::sync::Mutex::new(HashMap::new()),
            ai_ctx: Arc::new(RwLock::new(ai_ctx)),
        }
    }
}
