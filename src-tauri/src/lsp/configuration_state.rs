use crate::lsp::java_runtime::JavaLanguageSettings;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use std::time::Instant;

#[derive(Clone, Copy)]
pub(super) enum QaCompletionResolveFault {
    Null,
    Error,
}

pub(super) static QA_COMPLETION_RESOLVE_FAULT: StdMutex<Option<QaCompletionResolveFault>> =
    StdMutex::new(None);

#[derive(Clone, Copy)]
pub(super) struct CachedCommandAvailability {
    pub(super) available: bool,
    pub(super) checked_at: Instant,
}

pub(super) static COMMAND_AVAILABILITY_CACHE: OnceLock<
    StdMutex<HashMap<String, CachedCommandAvailability>>,
> = OnceLock::new();

/// User-configured JDK home / `java` binary path from Language Servers settings.
/// Prefer this over auto-detected JAVA_HOME/PATH so GUI-launched Taomni can use
/// a JDK that is not on the process environment (common on Windows).
pub(super) static CONFIGURED_JAVA_HOME: OnceLock<StdMutex<Option<PathBuf>>> = OnceLock::new();

/// User-configured jdtls JVM args (space-separated). `None` / empty → [`DEFAULT_JDTLS_VMARGS`].
pub(super) static CONFIGURED_JAVA_VMARGS: OnceLock<StdMutex<Option<String>>> = OnceLock::new();

/// User-configured `java.*` language settings (Lombok, autobuild, organize imports,
/// code generation, …). `None` → [`JavaLanguageSettings::default`]. Applied at jdtls
/// `initialize` and hot-updated via `workspace/didChangeConfiguration`.
pub(super) static CONFIGURED_JAVA_SETTINGS: OnceLock<StdMutex<Option<JavaLanguageSettings>>> =
    OnceLock::new();
