mod client_requests;

mod watcher;

mod manager;

mod workspace_symbols;

mod session;

mod transport;

mod java_runtime;

pub use java_runtime::*;

mod configuration_commands;

pub use configuration_commands::*;

mod document_commands;

pub use document_commands::*;

mod diagnostic_commands;

pub use diagnostic_commands::*;

mod navigation_commands;

pub use navigation_commands::*;

mod completion_commands;

pub use completion_commands::*;

mod edit_types;

pub use edit_types::*;

mod refactor_commands;

pub use refactor_commands::*;

mod java_sources;

pub use java_sources::*;

mod document_features;

pub use document_features::*;

mod java_project;

pub use java_project::*;

mod paths;

mod presets;

pub use presets::*;

mod protocol;

mod diagnostics;

mod capabilities;

mod edits;

mod navigation;

mod completion;

mod semantic_tokens;

#[cfg(test)]
mod tests;

use client_requests::*;

use watcher::*;

use workspace_symbols::*;

use session::*;

use transport::*;

use paths::*;

use protocol::*;

use diagnostics::*;

use capabilities::*;

use edits::*;

use navigation::*;

use completion::*;

use semantic_tokens::*;

use crate::sdk::{JavaRuntimeConfiguration, SdkManager, WorkspaceSdkEnvironment};

use crate::state::AppState;

use globset::GlobBuilder;

use notify::event::{ModifyKind, RenameMode};

use notify::{
    Config as NotifyConfig, Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};

use serde::{Deserialize, Serialize};

use serde_json::{Value, json};

use sha2::{Digest, Sha256};

use std::collections::{HashMap, HashSet, hash_map::DefaultHasher};

use std::hash::{Hash, Hasher};

use std::io::Read;

use std::path::{Path, PathBuf};

use std::process::Stdio;

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};

use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

use tokio::sync::{Mutex, Notify, RwLock, mpsc, oneshot};

use tokio_util::sync::CancellationToken;

mod limits;

mod configuration_state;

mod status_model;

mod lifetime_model;

mod feature_model;

mod navigation_model;

mod java_model;

mod symbol_model;

mod completion_model;

mod client_model;

mod document_model;

use limits::{
    BUILD_WORKSPACE_TIMEOUT_SECS, COMMAND_AVAILABILITY_TTL, DEFAULT_JDTLS_VMARGS,
    DIAGNOSTICS_REFRESH_EVENT, DOWNLOAD_SOURCES_POLL_ATTEMPTS, DOWNLOAD_SOURCES_POLL_INTERVAL_MS,
    EXIT_TIMEOUT_SECS, EXTERNAL_FILE_CHANGE_EVENT, INITIALIZE_TIMEOUT_SECS,
    JAVA_COMMAND_TIMEOUT_SECS, JDTLS_INITIALIZE_TIMEOUT_SECS, JDTLS_MIN_JAVA_MAJOR,
    JDTLS_WORKSPACE_MARKER, JSON_RPC_INTERNAL_ERROR, JSON_RPC_INVALID_PARAMS,
    JSON_RPC_METHOD_NOT_FOUND, LSP_REQUEST_CANCELLED, MAX_COMPLETION_ITEMS,
    MAX_VIRTUAL_DOCUMENT_BYTES, MAX_WORKSPACE_SYMBOL_DIAGNOSTICS, MAX_WORKSPACE_SYMBOL_PROVIDERS,
    MAX_WORKSPACE_SYMBOL_RAW_BYTES, MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCH_BYTES,
    MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCHES, MAX_WORKSPACE_SYMBOL_RESOLUTION_CACHE_BYTES,
    MAX_WORKSPACE_SYMBOLS, REFACTOR_RESOLVE_TIMEOUT_SECS, REQUEST_TIMEOUT_SECS,
    RUSTUP_SHIM_PROBE_TIMEOUT, SHOW_MESSAGE_CANCELLED_EVENT, SHOW_MESSAGE_EVENT,
    SHOW_MESSAGE_REQUEST_EVENT, SHOW_MESSAGE_REQUEST_TIMEOUT_SECS, SHUTDOWN_TIMEOUT_SECS,
    WATCH_KIND_ALL, WATCH_KIND_CHANGE, WATCH_KIND_CREATE, WATCH_KIND_DELETE,
    WORK_DONE_PROGRESS_EVENT, WORKSPACE_APPLY_EDIT_EVENT, WORKSPACE_APPLY_EDIT_TIMEOUT_SECS,
    WORKSPACE_DIAGNOSTIC_TIMEOUT_SECS, WORKSPACE_SYMBOL_RESOLUTION_TTL,
};

use configuration_state::{
    COMMAND_AVAILABILITY_CACHE, CONFIGURED_JAVA_HOME, CONFIGURED_JAVA_SETTINGS,
    CONFIGURED_JAVA_VMARGS, CachedCommandAvailability, QA_COMPLETION_RESOLVE_FAULT,
    QaCompletionResolveFault,
};

pub use status_model::{
    LspCustomServerCommand, LspDocumentStatus, LspServerCommandPreset, LspServerCommandStatus,
    LspServerPreset, LspServerStatus,
};

use status_model::DetectedLanguage;

pub use lifetime_model::{JavaSessionIdentity, LspManager};

use lifetime_model::{
    DynamicCapabilityRegistration, LspLastErrorRegistry, LspSession, LspSessionClaim,
    LspSessionEntry, LspSessionKey, LspSessionRegistry, LspSessionStart, PendingResponse,
    SemanticTokensCache, WorkDoneProgressState,
};

pub use feature_model::{
    LspCapabilitySummary, LspDiagnostic, LspDiagnosticRelatedInformation, LspDiagnosticsResult,
    LspDocumentContentChange, LspDocumentHighlight, LspDocumentHighlightsResult, LspInlayHint,
    LspInlayHintsResult, LspPosition, LspRange, LspSelectionRangesResult, LspSemanticToken,
    LspSemanticTokensResult, LspUriContentsResult,
};

pub use navigation_model::{
    LspCallHierarchyEntry, LspCallHierarchyResult, LspDocumentSymbol, LspDocumentSymbolsResult,
    LspHierarchyItem, LspHierarchyPrepareResult, LspHoverResult, LspLocation, LspLocationsResult,
    LspTypeHierarchyResult,
};

pub use java_model::{
    LspBuildFileHash, LspJavaClasspathProbe, LspJavaProjectModelResult, LspJavaProjectModule,
};

pub use symbol_model::{LspWorkspaceSymbol, LspWorkspaceSymbolsResult};

use symbol_model::{WorkspaceSymbolResolutionBatch, WorkspaceSymbolResolutionEntry};

pub use completion_model::{
    LspCompletionItem, LspCompletionResolveResult, LspCompletionResult, LspInsertReplaceEdit,
    LspSignatureHelpResult, LspSignatureInfo, LspSignatureParameter, LspTextEdit,
};

pub use client_model::LspWorkspaceApplyEditResponse;

use client_model::{
    LspClientRequestBridge, LspDiagnosticsRefreshEvent, LspExternalFileChangeEvent,
    LspShowMessageCancelledEvent, LspShowMessageEvent, LspShowMessageRequestEvent,
    LspWorkDoneProgressEvent, LspWorkspaceApplyEditRequest, PendingShowMessageRequest,
    PendingWorkspaceApplyEdit,
};

pub use document_model::WorkspaceDiagnosticFile;

use document_model::{
    LocalWatchedEvent, LocalWatchedSnapshot, ResolvedDocument, WorkspaceWatchTarget,
    WorkspaceWatcherHandle, file_path_from_uri,
};
