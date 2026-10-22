use super::client_model::LspClientRequestBridge;
use super::document_model::LocalWatchedEvent;
use super::document_model::WorkspaceWatcherHandle;
use super::feature_model::LspCapabilitySummary;
use super::feature_model::LspDiagnostic;
use super::status_model::LspCustomServerCommand;
use super::status_model::LspServerCommandPreset;
use super::status_model::LspServerPreset;
use super::symbol_model::WorkspaceSymbolResolutionBatch;
use crate::lsp::presets::cmd;
use crate::sdk::SdkManager;
use serde_json::Value;
use std::collections::HashMap;
use std::collections::HashSet;
use std::hash::Hash;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::AtomicU64;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::RwLock;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Which jdtls command the caller's editor session is bound to, so Java debug /
/// test `executeCommand` calls resolve the *same* session (matters when the user
/// configured a custom jdtls command or a non-default preset binary). Empty =
/// default preset lookup, matching the pre-identity behavior.
#[derive(Clone, Debug, Default)]
pub struct JavaSessionIdentity {
    pub preferred_command_id: Option<String>,
    pub custom_command: Option<LspCustomServerCommand>,
}

impl JavaSessionIdentity {
    /// Build from the frontend's optional command-id + custom-command pair,
    /// trimming blanks so an empty string does not shadow the preset default.
    pub fn new(
        preferred_command_id: Option<String>,
        custom_command: Option<LspCustomServerCommand>,
    ) -> Self {
        Self {
            preferred_command_id: preferred_command_id
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty()),
            custom_command: custom_command.filter(|cmd| !cmd.command.trim().is_empty()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct LspSessionKey {
    pub(super) workspace_id: String,
    pub(super) preset_id: String,
    pub(super) root_path: String,
    pub(super) command_id: String,
    pub(super) sdk_fingerprint: String,
}

impl LspSessionKey {
    pub(super) fn map_key(&self) -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}",
            self.workspace_id,
            self.preset_id,
            self.root_path,
            self.command_id,
            self.sdk_fingerprint
        )
    }
}

#[derive(Debug)]
pub(super) struct PendingResponse {
    pub(super) sender: oneshot::Sender<Result<Value, String>>,
    pub(super) document_uri: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct DynamicCapabilityRegistration {
    pub(super) id: String,
    pub(super) method: String,
    pub(super) register_options: Value,
}

#[derive(Clone, Debug)]
pub(super) struct SemanticTokensCache {
    pub(super) result_id: String,
    pub(super) data: Vec<u64>,
}

#[derive(Clone, Debug)]
pub(super) struct WorkDoneProgressState {
    pub(super) token: Value,
    pub(super) cancellable: bool,
    pub(super) title: Option<String>,
}

pub(super) type LspSessionRegistry = Arc<Mutex<HashMap<String, LspSessionEntry>>>;
pub(super) type LspLastErrorRegistry = Arc<Mutex<HashMap<String, String>>>;

pub struct LspManager {
    pub(super) sessions: LspSessionRegistry,
    /// Last unexpected exit / start failure per session key. Surfaced by
    /// `document_status` so the UI does not stick on a silent "starting…"
    /// after the process dies with `available=true, active=false`.
    pub(super) last_errors: LspLastErrorRegistry,
    pub(super) sdk: Arc<SdkManager>,
    pub(super) client_bridge: Arc<LspClientRequestBridge>,
    pub(super) workspace_watchers: Arc<Mutex<HashMap<String, WorkspaceWatcherHandle>>>,
    pub(super) local_watched_events:
        Arc<StdMutex<HashMap<(String, String, u8), LocalWatchedEvent>>>,
    pub(super) workspace_symbol_resolutions:
        Arc<Mutex<HashMap<String, WorkspaceSymbolResolutionBatch>>>,
    pub(super) workspace_symbol_queries: Arc<Mutex<HashMap<String, (u64, CancellationToken)>>>,
    pub(super) next_workspace_symbol_query_id: AtomicU64,
}

pub(super) enum LspSessionEntry {
    Starting(Arc<LspSessionStart>),
    Ready(Arc<LspSession>),
}

pub(super) enum LspSessionClaim {
    Start(Arc<LspSessionStart>),
    Wait(Arc<LspSessionStart>),
    Ready(Arc<LspSession>),
}

pub(super) struct LspSessionStart {
    pub(super) workspace_id: String,
    pub(super) result: Mutex<Option<Result<Arc<LspSession>, String>>>,
    pub(super) completed: Notify,
    pub(super) cancellation: Mutex<Option<String>>,
    pub(super) cancelled: Notify,
}

pub(super) struct LspSession {
    pub(super) key: LspSessionKey,
    pub(super) preset: LspServerPreset,
    pub(super) command: LspServerCommandPreset,
    pub(super) root_uri: String,
    pub(super) root_name: String,
    pub(super) stdin: Mutex<ChildStdin>,
    pub(super) pending: Mutex<HashMap<u64, PendingResponse>>,
    pub(super) incoming_show_message_requests: Mutex<HashMap<String, String>>,
    pub(super) opened_documents: RwLock<HashSet<String>>,
    pub(super) diagnostics: RwLock<HashMap<String, Vec<LspDiagnostic>>>,
    pub(super) diagnostic_result_ids: RwLock<HashMap<String, String>>,
    pub(super) diagnostic_pull_lock: Mutex<()>,
    /// Partial `workspace/diagnostic` reports are delivered through
    /// `$/progress` using a request-scoped token. Keep the raw report items
    /// until the matching final response arrives, then apply the complete
    /// report atomically.
    pub(super) diagnostic_partial_results: Mutex<HashMap<String, Vec<Value>>>,
    pub(super) diagnostic_provider_generation: AtomicU64,
    pub(super) semantic_ready: AtomicBool,
    pub(super) capabilities: RwLock<Option<LspCapabilitySummary>>,
    pub(super) server_capabilities: RwLock<Value>,
    /// `serverInfo` from the initialize result (§8.20.3 W2 provider identity).
    pub(super) server_info: RwLock<Option<Value>>,
    /// Resolved tooling JDK home used to launch this server (jdtls only).
    pub(super) tooling_java_home_used: Mutex<Option<PathBuf>>,
    pub(super) client_configuration: RwLock<Value>,
    pub(super) work_done_progress: RwLock<HashMap<String, WorkDoneProgressState>>,
    pub(super) dynamic_capabilities: RwLock<HashMap<String, DynamicCapabilityRegistration>>,
    pub(super) text_document_sync_kind: AtomicU8,
    pub(super) semantic_token_types: RwLock<Vec<String>>,
    pub(super) semantic_token_modifiers: RwLock<Vec<String>>,
    pub(super) semantic_tokens_delta: RwLock<bool>,
    pub(super) semantic_tokens_cache: RwLock<HashMap<String, SemanticTokensCache>>,
    pub(super) semantic_tokens_lock: Mutex<()>,
    pub(super) next_id: AtomicU64,
    pub(super) shutting_down: AtomicBool,
    pub(super) child: Mutex<Child>,
    pub(super) stderr_tail: Mutex<String>,
    pub(super) client_bridge: Arc<LspClientRequestBridge>,
}
