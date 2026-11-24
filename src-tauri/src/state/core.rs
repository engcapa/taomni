//! Shared core owners. Optional feature implementation state belongs in hosts.
use super::domains::*;
use crate::runtime::paths::ProfilePaths;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

pub struct CoreState {
    pub paths: ProfilePaths,
    pub tunnels: Arc<crate::tunnel::TunnelRegistry>,
    pub clipboard: Arc<Mutex<Option<arboard::Clipboard>>>,
    pub db: Mutex<rusqlite::Connection>,
    pub notes_db: Mutex<rusqlite::Connection>,
    pub vault: Arc<crate::vault::Vault>,
    pub opencode_go_catalog: Arc<crate::llm::opencode_go::catalog::CatalogService>,
    pub workspace: WorkspaceRuntime,
    pub terminal: TerminalRuntime,
    pub files: FileRuntime,
    pub database: DatabaseRuntime,
    pub agent: AgentRuntime,
    // Declared last: all stores and runtime owners close before profile locks release.
    pub(crate) _profile: Arc<crate::runtime::profile::ProfileRuntimeLeases>,
}

impl CoreState {
    pub(crate) fn new(
        paths: ProfilePaths,
        db: rusqlite::Connection,
        notes_db: rusqlite::Connection,
        vault: Arc<crate::vault::Vault>,
        profile: Arc<crate::runtime::profile::ProfileRuntimeLeases>,
    ) -> Self {
        let sdk = Arc::new(crate::sdk::SdkManager::load(
            paths.config.join("taomni/sdk.json"),
        ));
        let lsp = Arc::new(crate::lsp::LspManager::with_sdk(sdk.clone()));
        let dap = Arc::new(crate::dap::DapManager::with_lsp(lsp.clone()));
        Self {
            paths,
            _profile: profile,
            tunnels: Arc::new(crate::tunnel::TunnelRegistry::new()),
            clipboard: Arc::new(Mutex::new(None)),
            db: Mutex::new(db),
            notes_db: Mutex::new(notes_db),
            vault,
            opencode_go_catalog: crate::llm::opencode_go::catalog::shared_catalog(),
            workspace: WorkspaceRuntime { lsp, dap, sdk },
            terminal: TerminalRuntime {
                terminals: Arc::new(RwLock::new(HashMap::new())),
                terminal_outputs: Arc::new(crate::terminal::TerminalOutputHub::new()),
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
            database: DatabaseRuntime {
                db_connections: Arc::new(RwLock::new(HashMap::new())),
                hbase_sessions: Arc::new(RwLock::new(HashMap::new())),
            },
            agent: AgentRuntime {
                cc_processes: tokio::sync::Mutex::new(HashMap::new()),
                codex_processes: tokio::sync::Mutex::new(HashMap::new()),
                acp_processes: tokio::sync::Mutex::new(HashMap::new()),
                acp_media_processes: tokio::sync::Mutex::new(HashMap::new()),
                chat_runs: Arc::new(crate::chat::run::ChatRunRegistry::new(HashMap::new())),
                cc_pending_tool_calls: Arc::new(Mutex::new(HashMap::new())),
                cc_pending_permissions: Arc::new(Mutex::new(HashMap::new())),
                cc_pending_prompt_payloads: Arc::new(Mutex::new(HashMap::new())),
                thread_windows: Arc::new(crate::windowing::thread_delivery::ThreadWindows::new()),
                captures: Arc::new(crate::agent::capture::CaptureRegistry::new(
                    std::env::temp_dir().join("taomni-cc-captures"),
                )),
                cc_capture_cancels: Arc::new(Mutex::new(HashMap::new())),
                agent_thread_cwd: Arc::new(Mutex::new(HashMap::new())),
                cc_tab_sessions: Arc::new(Mutex::new(HashMap::new())),
                cc_tab_windows: Arc::new(Mutex::new(HashMap::new())),
                agent_db_bindings: Arc::new(RwLock::new(HashMap::new())),
                agent_db_selected_objects: Arc::new(RwLock::new(HashMap::new())),
                agent_code_workspaces: Arc::new(RwLock::new(HashMap::new())),
            },
        }
    }
}
