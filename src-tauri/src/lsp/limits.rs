use std::time::Duration;

pub(super) const REQUEST_TIMEOUT_SECS: u64 = 8;
/// Deferred refactor resolution computes AST changes after the user selects an
/// action. Cold JDT LS resolution can exceed the hover/completion budget.
pub(super) const REFACTOR_RESOLVE_TIMEOUT_SECS: u64 = 60;
/// Project-scope jdtls `executeCommand`s (java-debug's `resolveMainClass` /
/// `resolveClasspath` / `startDebugSession`, java-test discovery) search or
/// resolve the whole project and activate an OSGi bundle on first use, so they
/// routinely need more than the interactive [`REQUEST_TIMEOUT_SECS`] budget that
/// suits hover/completion. Too short a budget here reads to the user as "Debug
/// does nothing": the command is still running server-side when we give up.
pub(super) const JAVA_COMMAND_TIMEOUT_SECS: u64 = 60;
/// A workspace build is minutes-scale on a cold multi-module project.
pub(super) const BUILD_WORKSPACE_TIMEOUT_SECS: u64 = 600;
pub(super) const INITIALIZE_TIMEOUT_SECS: u64 = 20;
/// Eclipse JDT LS cold-start (especially on Windows) routinely exceeds 20s.
pub(super) const JDTLS_INITIALIZE_TIMEOUT_SECS: u64 = 120;
/// Current Eclipse JDT LS (snapshot/milestones) requires a modern JDK; the
/// upstream `jdtls.py` launcher refuses anything below this major version.
pub(super) const JDTLS_MIN_JAVA_MAJOR: u32 = 21;
/// Default jdtls JVM args when Settings has no override (matches prior 1G heap).
pub(super) const DEFAULT_JDTLS_VMARGS: &str = "-Xms1024m -Xmx1024m";
/// Marker file inside each jdtls `-data` dir naming the project it indexes, used to
/// prune indexes whose project has been deleted/renamed.
pub(super) const JDTLS_WORKSPACE_MARKER: &str = ".taomni-workspace";
/// On-demand source download: how many times to re-poll classFileContents while the
/// build tool fetches the sources JAR, and how long to wait between polls. ~24s total
/// budget covers a cold Maven/Gradle source fetch without hanging the UI forever.
pub(super) const DOWNLOAD_SOURCES_POLL_ATTEMPTS: u32 = 20;
pub(super) const DOWNLOAD_SOURCES_POLL_INTERVAL_MS: u64 = 1200;
/// Bound archive/virtual source reads so a corrupt server URI or compressed
/// dependency cannot turn a navigation action into an unbounded allocation.
pub(super) const MAX_VIRTUAL_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
/// Bound workspace/symbol fan-out and response materialization. A language
/// server is allowed to return an arbitrarily large array; the editor must
/// keep the query deterministic and responsive instead of trusting that size.
pub(super) const MAX_WORKSPACE_SYMBOLS: usize = 20_000;
pub(super) const MAX_WORKSPACE_SYMBOL_PROVIDERS: usize = 64;
pub(super) const MAX_WORKSPACE_SYMBOL_DIAGNOSTICS: usize = 32;
/// Completion items carry the provider payload twice: normalized display/apply
/// fields plus the opaque item echoed to completionItem/resolve. JDTLS can
/// return thousands of entries, so bound parsing and IPC serialization before
/// the response reaches the renderer thread.
pub(super) const MAX_COMPLETION_ITEMS: usize = 200;
/// Keep opaque workspace-symbol resolve payloads short-lived and bounded. The
/// token is only a routing handle; the raw provider payload never crosses the
/// frontend boundary.
pub(super) const WORKSPACE_SYMBOL_RESOLUTION_TTL: Duration = Duration::from_secs(300);
pub(super) const MAX_WORKSPACE_SYMBOL_RAW_BYTES: usize = 64 * 1024;
pub(super) const MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_WORKSPACE_SYMBOL_RESOLUTION_CACHE_BYTES: usize = 32 * 1024 * 1024;
pub(super) const MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCHES: usize = 8;
pub(super) const SHUTDOWN_TIMEOUT_SECS: u64 = 3;
pub(super) const EXIT_TIMEOUT_SECS: u64 = 2;
pub(super) const COMMAND_AVAILABILITY_TTL: Duration = Duration::from_secs(30);
pub(super) const RUSTUP_SHIM_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const WORKSPACE_APPLY_EDIT_TIMEOUT_SECS: u64 = 30;
pub(super) const SHOW_MESSAGE_REQUEST_TIMEOUT_SECS: u64 = 300;
pub(super) const WORKSPACE_DIAGNOSTIC_TIMEOUT_SECS: u64 = 30;
pub(super) const WORKSPACE_APPLY_EDIT_EVENT: &str = "lsp://workspace-apply-edit";
pub(super) const SHOW_MESSAGE_REQUEST_EVENT: &str = "lsp://show-message-request";
pub(super) const SHOW_MESSAGE_CANCELLED_EVENT: &str = "lsp://show-message-cancelled";
pub(super) const SHOW_MESSAGE_EVENT: &str = "lsp://show-message";
pub(super) const WORK_DONE_PROGRESS_EVENT: &str = "lsp://work-done-progress";
pub(super) const DIAGNOSTICS_REFRESH_EVENT: &str = "lsp://diagnostics-refresh";
pub(super) const EXTERNAL_FILE_CHANGE_EVENT: &str = "lsp://external-file-change";
pub(super) const JSON_RPC_METHOD_NOT_FOUND: i64 = -32601;
pub(super) const JSON_RPC_INVALID_PARAMS: i64 = -32602;
pub(super) const JSON_RPC_INTERNAL_ERROR: i64 = -32603;
pub(super) const LSP_REQUEST_CANCELLED: i64 = -32800;
pub(super) const WATCH_KIND_CREATE: u8 = 1;
pub(super) const WATCH_KIND_CHANGE: u8 = 2;
pub(super) const WATCH_KIND_DELETE: u8 = 4;
pub(super) const WATCH_KIND_ALL: u8 = WATCH_KIND_CREATE | WATCH_KIND_CHANGE | WATCH_KIND_DELETE;
