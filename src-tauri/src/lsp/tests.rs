use super::*;

use serde_json::json;

/// Serializes tests that mutate the process-global jdtls vmargs / java settings
/// (both feed `jdtls_vmargs()`), so parallel runs do not clobber each other.
static JAVA_GLOBALS_LOCK: StdMutex<()> = StdMutex::new(());

mod completion;
mod diagnostics_and_operations;
mod java_runtime_and_paths;
mod lifecycle_and_configuration;
mod navigation_and_semantic_tokens;
mod protocol_errors;
mod providers_and_requests;
mod symbols;
mod watchers_and_capabilities;
mod workspace_edits;
mod workspace_watch_lifetime;
mod workspace_watch_registration;
