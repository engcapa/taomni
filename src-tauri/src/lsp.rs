mod client_requests;
use client_requests::*;
mod watcher;
use watcher::*;
mod manager;
mod workspace_symbols;
use workspace_symbols::*;
mod session;
use session::*;
mod transport;
use transport::*;
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
use paths::*;
mod presets;
pub use presets::*;
mod protocol;
use protocol::*;
mod diagnostics;
use diagnostics::*;
mod capabilities;
use capabilities::*;
mod edits;
use edits::*;
mod navigation;
use navigation::*;
mod completion;
use completion::*;
mod semantic_tokens;
use semantic_tokens::*;
#[cfg(test)]
mod tests;

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

const REQUEST_TIMEOUT_SECS: u64 = 8;
/// Deferred refactor resolution computes AST changes after the user selects an
/// action. Cold JDT LS resolution can exceed the hover/completion budget.
const REFACTOR_RESOLVE_TIMEOUT_SECS: u64 = 60;
/// Project-scope jdtls `executeCommand`s (java-debug's `resolveMainClass` /
/// `resolveClasspath` / `startDebugSession`, java-test discovery) search or
/// resolve the whole project and activate an OSGi bundle on first use, so they
/// routinely need more than the interactive [`REQUEST_TIMEOUT_SECS`] budget that
/// suits hover/completion. Too short a budget here reads to the user as "Debug
/// does nothing": the command is still running server-side when we give up.
const JAVA_COMMAND_TIMEOUT_SECS: u64 = 60;
/// A workspace build is minutes-scale on a cold multi-module project.
const BUILD_WORKSPACE_TIMEOUT_SECS: u64 = 600;
const INITIALIZE_TIMEOUT_SECS: u64 = 20;
/// Eclipse JDT LS cold-start (especially on Windows) routinely exceeds 20s.
const JDTLS_INITIALIZE_TIMEOUT_SECS: u64 = 120;
/// Current Eclipse JDT LS (snapshot/milestones) requires a modern JDK; the
/// upstream `jdtls.py` launcher refuses anything below this major version.
const JDTLS_MIN_JAVA_MAJOR: u32 = 21;
/// Default jdtls JVM args when Settings has no override (matches prior 1G heap).
const DEFAULT_JDTLS_VMARGS: &str = "-Xms1024m -Xmx1024m";
/// Marker file inside each jdtls `-data` dir naming the project it indexes, used to
/// prune indexes whose project has been deleted/renamed.
const JDTLS_WORKSPACE_MARKER: &str = ".taomni-workspace";
/// On-demand source download: how many times to re-poll classFileContents while the
/// build tool fetches the sources JAR, and how long to wait between polls. ~24s total
/// budget covers a cold Maven/Gradle source fetch without hanging the UI forever.
const DOWNLOAD_SOURCES_POLL_ATTEMPTS: u32 = 20;
const DOWNLOAD_SOURCES_POLL_INTERVAL_MS: u64 = 1200;
/// Bound archive/virtual source reads so a corrupt server URI or compressed
/// dependency cannot turn a navigation action into an unbounded allocation.
const MAX_VIRTUAL_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
/// Bound workspace/symbol fan-out and response materialization. A language
/// server is allowed to return an arbitrarily large array; the editor must
/// keep the query deterministic and responsive instead of trusting that size.
const MAX_WORKSPACE_SYMBOLS: usize = 20_000;
const MAX_WORKSPACE_SYMBOL_PROVIDERS: usize = 64;
const MAX_WORKSPACE_SYMBOL_DIAGNOSTICS: usize = 32;
/// Completion items carry the provider payload twice: normalized display/apply
/// fields plus the opaque item echoed to completionItem/resolve. JDTLS can
/// return thousands of entries, so bound parsing and IPC serialization before
/// the response reaches the renderer thread.
const MAX_COMPLETION_ITEMS: usize = 200;

#[derive(Clone, Copy)]
enum QaCompletionResolveFault {
    Null,
    Error,
}

static QA_COMPLETION_RESOLVE_FAULT: StdMutex<Option<QaCompletionResolveFault>> =
    StdMutex::new(None);
/// Keep opaque workspace-symbol resolve payloads short-lived and bounded. The
/// token is only a routing handle; the raw provider payload never crosses the
/// frontend boundary.
const WORKSPACE_SYMBOL_RESOLUTION_TTL: Duration = Duration::from_secs(300);
const MAX_WORKSPACE_SYMBOL_RAW_BYTES: usize = 64 * 1024;
const MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKSPACE_SYMBOL_RESOLUTION_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCHES: usize = 8;
const SHUTDOWN_TIMEOUT_SECS: u64 = 3;
const EXIT_TIMEOUT_SECS: u64 = 2;
const COMMAND_AVAILABILITY_TTL: Duration = Duration::from_secs(30);
const RUSTUP_SHIM_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const WORKSPACE_APPLY_EDIT_TIMEOUT_SECS: u64 = 30;
const SHOW_MESSAGE_REQUEST_TIMEOUT_SECS: u64 = 300;
const WORKSPACE_DIAGNOSTIC_TIMEOUT_SECS: u64 = 30;
const WORKSPACE_APPLY_EDIT_EVENT: &str = "lsp://workspace-apply-edit";
const SHOW_MESSAGE_REQUEST_EVENT: &str = "lsp://show-message-request";
const SHOW_MESSAGE_CANCELLED_EVENT: &str = "lsp://show-message-cancelled";
const SHOW_MESSAGE_EVENT: &str = "lsp://show-message";
const WORK_DONE_PROGRESS_EVENT: &str = "lsp://work-done-progress";
const DIAGNOSTICS_REFRESH_EVENT: &str = "lsp://diagnostics-refresh";
const EXTERNAL_FILE_CHANGE_EVENT: &str = "lsp://external-file-change";
const JSON_RPC_METHOD_NOT_FOUND: i64 = -32601;
const JSON_RPC_INVALID_PARAMS: i64 = -32602;
const JSON_RPC_INTERNAL_ERROR: i64 = -32603;
const LSP_REQUEST_CANCELLED: i64 = -32800;
const WATCH_KIND_CREATE: u8 = 1;
const WATCH_KIND_CHANGE: u8 = 2;
const WATCH_KIND_DELETE: u8 = 4;
const WATCH_KIND_ALL: u8 = WATCH_KIND_CREATE | WATCH_KIND_CHANGE | WATCH_KIND_DELETE;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerCommandPreset {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub install_hint: String,
    #[serde(default)]
    pub fallback: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCustomServerCommand {
    #[serde(default)]
    pub label: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerPreset {
    pub id: String,
    pub display_name: String,
    pub document_language_ids: Vec<String>,
    pub file_extensions: Vec<String>,
    pub file_names: Vec<String>,
    pub commands: Vec<LspServerCommandPreset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerCommandStatus {
    pub id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub install_hint: String,
    pub fallback: bool,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub preset_id: String,
    pub display_name: String,
    pub document_language_ids: Vec<String>,
    pub available: bool,
    pub active: bool,
    pub selected_command_id: Option<String>,
    pub selected_command: Option<String>,
    pub install_hint: String,
    pub error: Option<String>,
    /// Human-readable runtime probe for Settings (e.g. Java major + path for jdtls).
    #[serde(default)]
    pub runtime_status: Option<String>,
    pub commands: Vec<LspServerCommandStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentStatus {
    pub path: String,
    pub uri: String,
    pub preset_id: Option<String>,
    pub language_id: Option<String>,
    pub display_name: Option<String>,
    pub available: bool,
    pub active: bool,
    /// True once the provider can answer semantic requests for this workspace.
    /// JDT LS initializes before Maven/Gradle import and reports this separately.
    #[serde(default)]
    pub semantic_ready: bool,
    pub selected_command_id: Option<String>,
    pub selected_command: Option<String>,
    pub install_hint: Option<String>,
    pub error: Option<String>,
    /// Present only while a session is active for this document.
    #[serde(default)]
    pub capabilities: Option<LspCapabilitySummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentContentChange {
    pub range: LspRange,
    pub range_length: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub range: LspRange,
    pub severity: Option<u8>,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
    pub tags: Vec<u8>,
    pub related_information: Vec<LspDiagnosticRelatedInformation>,
    pub code_description: Option<String>,
    pub data: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticRelatedInformation {
    pub location: LspLocation,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsResult {
    pub status: LspDocumentStatus,
    pub diagnostics: Vec<LspDiagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHoverResult {
    pub status: LspDocumentStatus,
    pub contents: Option<String>,
    pub range: Option<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocationsResult {
    pub status: LspDocumentStatus,
    pub locations: Vec<LspLocation>,
}

/// One provider-reported Java project/module root (`java.project.list`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspJavaProjectModule {
    pub id: String,
    pub root_uri: Option<String>,
}

/// §8.20.3 W2: hashed summary of one project's resolved classpath. Entry
/// paths are never returned verbatim — only their count and joint hash —
/// so fingerprints stay free of machine-local plaintext.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspJavaClasspathProbe {
    pub root_uri: Option<String>,
    pub entry_count: u64,
    pub entries_sha256: String,
}

/// Build descriptor under a workspace root (pom.xml / build.gradle* /
/// settings.gradle*) with its content hash. Feeds the project fingerprint.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspBuildFileHash {
    pub path: String,
    pub sha256: String,
}

/// Provider-owned Project Analysis facts (§8.20.3 W2). Lifecycle-only
/// providers leave `classpath_probe` unset and explain why in
/// `probe_reason`; the frontend derives phase/completeness from exactly
/// these fields and never invents module details.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspJavaProjectModelResult {
    pub status: LspDocumentStatus,
    pub active: bool,
    pub process_id: Option<u32>,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    /// `workspace/executeCommand` command names the provider registered.
    pub registered_commands: Vec<String>,
    pub build_files: Vec<LspBuildFileHash>,
    /// Tooling JDK home used to launch this session (hashed client-side;
    /// never embedded verbatim into fingerprints or traces).
    pub java_home_used: Option<String>,
    pub java_projects: Vec<LspJavaProjectModule>,
    pub classpath_probe: Option<LspJavaClasspathProbe>,
    pub probe_reason: Option<String>,
}

/// Contents of a library / virtual document (JDK, dependency JAR, jdt:// URI).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspUriContentsResult {
    pub status: LspDocumentStatus,
    pub uri: String,
    pub path: Option<String>,
    pub title: String,
    /// Human label for where the source came from (package · jar/module).
    pub container: Option<String>,
    pub language_id: String,
    pub text: String,
    pub read_only: bool,
    /// True when `text` is FernFlower-decompiled bytecode rather than attached
    /// source. The UI offers "Download sources" in this case (jdtls only).
    pub decompiled: bool,
}

/// One entry of a flattened `textDocument/documentSymbol` tree; `depth`
/// preserves the hierarchy for indented rendering.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: u32,
    pub depth: u32,
    pub range: LspRange,
    pub selection_range: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspDocumentSymbol>,
}

/// Workspace-wide symbol hit from `workspace/symbol`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceSymbol {
    pub name: String,
    pub kind: u32,
    pub container_name: Option<String>,
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
    pub selection_range: LspRange,
    /// False when the provider returned only a URI and requires
    /// `workspaceSymbol/resolve` before a location is available.
    #[serde(default)]
    pub resolved: bool,
    /// Short-lived opaque handle for a deferred provider resolve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_token: Option<String>,
    #[serde(skip)]
    raw: Option<Value>,
    #[serde(skip)]
    provider_session_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspWorkspaceSymbol>,
    /// Number of ready language-server sessions discovered for this workspace.
    #[serde(default)]
    pub session_count: u32,
    /// Number of discovered sessions that advertised workspace/symbol and were
    /// actually queried (bounded by the provider fan-out limit).
    #[serde(default)]
    pub provider_count: u32,
    /// Ready sessions that were not queried because they did not advertise
    /// workspace/symbol or fell outside the bounded provider fan-out.
    #[serde(default)]
    pub skipped_provider_count: u32,
    /// Providers whose request or response could not be consumed.
    #[serde(default)]
    pub failed_provider_count: u32,
    /// False when at least one provider failed, no provider was available, or
    /// the bounded result limit was reached. Consumers must not present an
    /// incomplete result as an authoritative project index.
    #[serde(default)]
    pub complete: bool,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<String>,
}

struct WorkspaceSymbolResolutionBatch {
    workspace_id: String,
    created_at: Instant,
    bytes: usize,
    entries: HashMap<String, WorkspaceSymbolResolutionEntry>,
}

#[derive(Clone)]
struct WorkspaceSymbolResolutionEntry {
    session: Weak<LspSession>,
    raw: Value,
}

/// Normalized CallHierarchyItem / TypeHierarchyItem. `raw` is echoed back to
/// the server for lazy child requests so opaque server `data` is preserved.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHierarchyItem {
    pub name: String,
    pub detail: Option<String>,
    pub kind: u32,
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
    pub selection_range: LspRange,
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHierarchyPrepareResult {
    pub status: LspDocumentStatus,
    pub items: Vec<LspHierarchyItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCallHierarchyEntry {
    pub item: LspHierarchyItem,
    pub from_ranges: Vec<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCallHierarchyResult {
    pub status: LspDocumentStatus,
    pub entries: Vec<LspCallHierarchyEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTypeHierarchyResult {
    pub status: LspDocumentStatus,
    pub items: Vec<LspHierarchyItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentHighlight {
    pub range: LspRange,
    /// 1 = text, 2 = read, 3 = write.
    pub kind: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentHighlightsResult {
    pub status: LspDocumentStatus,
    pub highlights: Vec<LspDocumentHighlight>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInlayHint {
    pub position: LspPosition,
    pub label: String,
    /// 1 = type, 2 = parameter.
    pub kind: Option<u8>,
    pub tooltip: Option<String>,
    pub padding_left: bool,
    pub padding_right: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInlayHintsResult {
    pub status: LspDocumentStatus,
    pub hints: Vec<LspInlayHint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSelectionRangesResult {
    pub status: LspDocumentStatus,
    /// Innermost to outermost range for the requested position.
    pub ranges: Vec<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSemanticToken {
    pub range: LspRange,
    pub token_type: String,
    pub modifiers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSemanticTokensResult {
    pub status: LspDocumentStatus,
    pub tokens: Vec<LspSemanticToken>,
}

/// Feature summary distilled from the server's `initialize` response so the
/// UI can enable/disable entry points per capability instead of guessing.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCapabilitySummary {
    /// 0 = none, 1 = full, 2 = incremental.
    pub text_document_sync_kind: u8,
    pub completion: bool,
    pub signature_help: bool,
    pub hover: bool,
    pub definition: bool,
    pub declaration: bool,
    pub type_definition: bool,
    pub implementation: bool,
    pub references: bool,
    pub document_symbol: bool,
    pub workspace_symbol: bool,
    /// The workspace-symbol provider accepts `workspaceSymbol/resolve`.
    pub workspace_symbol_resolve: bool,
    pub rename: bool,
    pub formatting: bool,
    pub range_formatting: bool,
    pub code_action: bool,
    pub document_highlight: bool,
    pub call_hierarchy: bool,
    pub type_hierarchy: bool,
    pub inlay_hint: bool,
    pub selection_range: bool,
    pub semantic_tokens: bool,
    pub workspace_diagnostics: bool,
    pub code_action_kinds: Vec<String>,
    pub completion_trigger_characters: Vec<String>,
    pub signature_trigger_characters: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTextEdit {
    pub range: LspRange,
    pub new_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInsertReplaceEdit {
    pub new_text: String,
    pub insert: LspRange,
    pub replace: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionItem {
    pub label: String,
    pub kind: Option<u32>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: Option<String>,
    /// 1 = plain text, 2 = snippet (`${1:placeholder}` syntax).
    pub insert_text_format: Option<u32>,
    pub filter_text: Option<String>,
    pub sort_text: Option<String>,
    pub text_edit: Option<LspTextEdit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_replace_edit: Option<LspInsertReplaceEdit>,
    pub additional_text_edits: Vec<LspTextEdit>,
    /// Original server item, echoed back verbatim for `completionItem/resolve`.
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionResult {
    pub status: LspDocumentStatus,
    pub is_incomplete: bool,
    pub items: Vec<LspCompletionItem>,
    /// True when the server list was locally truncated at the hard cap.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LspCompletionResolveResult {
    Resolved { item: LspCompletionItem },
    Unavailable { reason: String },
    Timeout,
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureParameter {
    pub label: String,
    pub documentation: Option<String>,
    /// Offsets into the signature label when the server sends `[start, end]`.
    pub label_start: Option<u32>,
    pub label_end: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureInfo {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<LspSignatureParameter>,
    pub active_parameter: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureHelpResult {
    pub status: LspDocumentStatus,
    pub signatures: Vec<LspSignatureInfo>,
    pub active_signature: u32,
    pub active_parameter: u32,
}

#[derive(Clone, Debug)]
struct DetectedLanguage {
    preset_id: String,
    language_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct LspSessionKey {
    workspace_id: String,
    preset_id: String,
    root_path: String,
    command_id: String,
    sdk_fingerprint: String,
}

impl LspSessionKey {
    fn map_key(&self) -> String {
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
struct PendingResponse {
    sender: oneshot::Sender<Result<Value, String>>,
    document_uri: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceApplyEditResponse {
    pub applied: bool,
    pub failure_reason: Option<String>,
    pub failed_change: Option<u32>,
}

impl LspWorkspaceApplyEditResponse {
    fn failed(reason: impl Into<String>) -> Self {
        Self {
            applied: false,
            failure_reason: Some(reason.into()),
            failed_change: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspWorkspaceApplyEditRequest {
    request_id: String,
    workspace_id: String,
    label: Option<String>,
    edit: LspWorkspaceEdit,
}

struct PendingWorkspaceApplyEdit {
    workspace_id: String,
    sender: oneshot::Sender<LspWorkspaceApplyEditResponse>,
}

struct PendingShowMessageRequest {
    workspace_id: String,
    actions: Vec<Value>,
    sender: oneshot::Sender<Option<Value>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspShowMessageRequestEvent {
    request_id: String,
    workspace_id: String,
    server_label: String,
    message_type: u32,
    message: String,
    actions: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspShowMessageCancelledEvent {
    request_id: String,
    workspace_id: String,
    reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspShowMessageEvent {
    workspace_id: String,
    server_label: String,
    message_type: u32,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspWorkDoneProgressEvent {
    workspace_id: String,
    preset_id: String,
    server_label: String,
    root_uri: String,
    token: Value,
    kind: String,
    title: Option<String>,
    message: Option<String>,
    percentage: Option<u32>,
    cancellable: bool,
}

/// Server-initiated `workspace/diagnostic/refresh` notification for the
/// renderer. Pull diagnostics are otherwise only refreshed by the Problems
/// poller; forwarding this event keeps open-file squiggles and the project
/// Problems view in sync as soon as the server invalidates its report.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspDiagnosticsRefreshEvent {
    workspace_id: String,
    preset_id: String,
    root_uri: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspExternalFileChangeEvent {
    workspace_id: String,
    path: String,
    #[serde(rename = "type")]
    change_type: u8,
}

struct LspClientRequestBridge {
    app: OnceLock<AppHandle>,
    pending_workspace_edits: StdMutex<HashMap<String, PendingWorkspaceApplyEdit>>,
    pending_show_messages: StdMutex<HashMap<String, PendingShowMessageRequest>>,
    next_request_id: AtomicU64,
}

#[derive(Clone, Debug, PartialEq)]
struct DynamicCapabilityRegistration {
    id: String,
    method: String,
    register_options: Value,
}

#[derive(Clone, Copy)]
struct CachedCommandAvailability {
    available: bool,
    checked_at: Instant,
}

static COMMAND_AVAILABILITY_CACHE: OnceLock<StdMutex<HashMap<String, CachedCommandAvailability>>> =
    OnceLock::new();

/// User-configured JDK home / `java` binary path from Language Servers settings.
/// Prefer this over auto-detected JAVA_HOME/PATH so GUI-launched Taomni can use
/// a JDK that is not on the process environment (common on Windows).
static CONFIGURED_JAVA_HOME: OnceLock<StdMutex<Option<PathBuf>>> = OnceLock::new();

/// User-configured jdtls JVM args (space-separated). `None` / empty → [`DEFAULT_JDTLS_VMARGS`].
static CONFIGURED_JAVA_VMARGS: OnceLock<StdMutex<Option<String>>> = OnceLock::new();

/// User-configured `java.*` language settings (Lombok, autobuild, organize imports,
/// code generation, …). `None` → [`JavaLanguageSettings::default`]. Applied at jdtls
/// `initialize` and hot-updated via `workspace/didChangeConfiguration`.
static CONFIGURED_JAVA_SETTINGS: OnceLock<StdMutex<Option<JavaLanguageSettings>>> = OnceLock::new();

#[derive(Clone, Debug)]
struct SemanticTokensCache {
    result_id: String,
    data: Vec<u64>,
}

#[derive(Clone, Debug)]
struct WorkDoneProgressState {
    token: Value,
    cancellable: bool,
    title: Option<String>,
}

type LspSessionRegistry = Arc<Mutex<HashMap<String, LspSessionEntry>>>;
type LspLastErrorRegistry = Arc<Mutex<HashMap<String, String>>>;

struct WorkspaceWatcherHandle {
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone, Debug)]
struct WorkspaceWatchTarget {
    /// Whether notify should recurse below the requested directory.
    recursive: bool,
    /// Logical path used to discard events outside the requested workspace root
    /// or loose file. For a missing loose file this is the file itself, not its
    /// parent directory.
    filter_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum LocalWatchedSnapshot {
    Missing,
    File(String),
}

#[derive(Clone, Debug)]
struct LocalWatchedEvent {
    at: Instant,
    snapshot: LocalWatchedSnapshot,
}

pub struct LspManager {
    sessions: LspSessionRegistry,
    /// Last unexpected exit / start failure per session key. Surfaced by
    /// `document_status` so the UI does not stick on a silent "starting…"
    /// after the process dies with `available=true, active=false`.
    last_errors: LspLastErrorRegistry,
    sdk: Arc<SdkManager>,
    client_bridge: Arc<LspClientRequestBridge>,
    workspace_watchers: Arc<Mutex<HashMap<String, WorkspaceWatcherHandle>>>,
    local_watched_events: Arc<StdMutex<HashMap<(String, String, u8), LocalWatchedEvent>>>,
    workspace_symbol_resolutions: Arc<Mutex<HashMap<String, WorkspaceSymbolResolutionBatch>>>,
    workspace_symbol_queries: Arc<Mutex<HashMap<String, (u64, CancellationToken)>>>,
    next_workspace_symbol_query_id: AtomicU64,
}

enum LspSessionEntry {
    Starting(Arc<LspSessionStart>),
    Ready(Arc<LspSession>),
}

enum LspSessionClaim {
    Start(Arc<LspSessionStart>),
    Wait(Arc<LspSessionStart>),
    Ready(Arc<LspSession>),
}

struct LspSessionStart {
    workspace_id: String,
    result: Mutex<Option<Result<Arc<LspSession>, String>>>,
    completed: Notify,
    cancellation: Mutex<Option<String>>,
    cancelled: Notify,
}

struct LspSession {
    key: LspSessionKey,
    preset: LspServerPreset,
    command: LspServerCommandPreset,
    root_uri: String,
    root_name: String,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, PendingResponse>>,
    incoming_show_message_requests: Mutex<HashMap<String, String>>,
    opened_documents: RwLock<HashSet<String>>,
    diagnostics: RwLock<HashMap<String, Vec<LspDiagnostic>>>,
    diagnostic_result_ids: RwLock<HashMap<String, String>>,
    diagnostic_pull_lock: Mutex<()>,
    /// Partial `workspace/diagnostic` reports are delivered through
    /// `$/progress` using a request-scoped token. Keep the raw report items
    /// until the matching final response arrives, then apply the complete
    /// report atomically.
    diagnostic_partial_results: Mutex<HashMap<String, Vec<Value>>>,
    diagnostic_provider_generation: AtomicU64,
    semantic_ready: AtomicBool,
    capabilities: RwLock<Option<LspCapabilitySummary>>,
    server_capabilities: RwLock<Value>,
    /// `serverInfo` from the initialize result (§8.20.3 W2 provider identity).
    server_info: RwLock<Option<Value>>,
    /// Resolved tooling JDK home used to launch this server (jdtls only).
    tooling_java_home_used: Mutex<Option<PathBuf>>,
    client_configuration: RwLock<Value>,
    work_done_progress: RwLock<HashMap<String, WorkDoneProgressState>>,
    dynamic_capabilities: RwLock<HashMap<String, DynamicCapabilityRegistration>>,
    text_document_sync_kind: AtomicU8,
    semantic_token_types: RwLock<Vec<String>>,
    semantic_token_modifiers: RwLock<Vec<String>>,
    semantic_tokens_delta: RwLock<bool>,
    semantic_tokens_cache: RwLock<HashMap<String, SemanticTokensCache>>,
    semantic_tokens_lock: Mutex<()>,
    next_id: AtomicU64,
    shutting_down: AtomicBool,
    child: Mutex<Child>,
    stderr_tail: Mutex<String>,
    client_bridge: Arc<LspClientRequestBridge>,
}

#[derive(Clone)]
struct ResolvedDocument {
    path: PathBuf,
    uri: String,
    root_path: PathBuf,
    workspace_id: String,
    preset: Option<LspServerPreset>,
    language_id: Option<String>,
    version: i64,
}

/// One file's diagnostics for the workspace-wide Problems view (M7-C).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiagnosticFile {
    /// Absolute filesystem path (from the `file:` URI).
    pub path: String,
    pub uri: String,
    pub diagnostics: Vec<LspDiagnostic>,
}

/// Convert a `file:` URI to an absolute path; `None` for `jdt://` / non-file URIs.
fn file_path_from_uri(uri: &str) -> Option<String> {
    url::Url::parse(uri)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}
