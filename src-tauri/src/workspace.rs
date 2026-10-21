mod tasks;
use tasks::*;
mod dependencies;
pub use dependencies::*;
mod java_targets;
use java_targets::*;
mod task_commands;
pub use task_commands::*;
mod file_commands;
pub use file_commands::*;
mod resource_operations;
pub use resource_operations::*;
mod paths;
pub use paths::*;
mod files;
pub use files::*;
mod git_roots;
use git_roots::*;
mod atomic_write;
use atomic_write::*;
mod encoding;
use encoding::*;
#[cfg(test)]
mod tests;

use crate::state::AppState;
use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::State;

const DEFAULT_MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_RECURSIVE_MAX_DEPTH: usize = 25;
const DEFAULT_RECURSIVE_MAX_FILES: usize = 2_000;
const HARD_RECURSIVE_MAX_DEPTH: usize = 100;
const HARD_RECURSIVE_MAX_FILES: usize = 10_000;
const GIT_ROOT_SCAN_MAX_DEPTH: usize = 4;
const GIT_ROOT_SCAN_MAX_DIRS: usize = 2_000;
static RESOURCE_BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size: u64,
    pub mtime: u64,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub text: String,
    /// Decoded editor encoding (for example UTF-8, GBK, or windows-1252).
    /// `bom` records a Unicode byte-order marker independently so it can
    /// round-trip without exposing it as an editor character.
    pub encoding: String,
    pub bom: bool,
    pub size: u64,
    pub mtime: u64,
    pub hash: String,
}

/// Disk-effect fact carried by a typed write error (§8.18.1). `None` means
/// the native layer can prove the target bytes were not touched; `Unknown`
/// means the bridge cannot prove whether the replace happened, so the
/// frontend must re-read and verify against hashes before retrying.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceWriteEffect {
    None,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWriteError {
    pub kind: WorkspaceWriteErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_hash: Option<String>,
    /// Absent on legacy producers; present on every byte-writer failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<WorkspaceWriteEffect>,
    /// Set when bytes were provably written but the post-write read-back
    /// failed: lets the frontend classify committed without another write.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub written_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub written_byte_length: Option<u64>,
    /// SHA-256 of exactly the encoded bytes this writer intended to put on
    /// disk (§8.19.1 unified fact model). Present whenever encoding succeeded,
    /// so an `unknown`-effect failure still lets the frontend record a real
    /// intended hash in its recovery ledger instead of a null placeholder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_byte_length: Option<u64>,
    /// SHA-256 of the target bytes observed before any mutation attempt, when
    /// the writer read them (absent for a not-yet-existing target).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceWriteErrorKind {
    HashMismatch,
    Encoding,
    Permission,
    Io,
}

impl std::fmt::Display for WorkspaceWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for WorkspaceWriteError {}

impl WorkspaceWriteError {
    pub fn new(kind: WorkspaceWriteErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            expected_hash: None,
            actual_hash: None,
            effect: None,
            written_hash: None,
            written_byte_length: None,
            intent_hash: None,
            intent_byte_length: None,
            old_hash: None,
        }
    }

    /// Attach the native disk-effect fact (and, when known, the written byte
    /// identity) to this error.
    pub fn with_effect(
        mut self,
        effect: WorkspaceWriteEffect,
        written: Option<(String, u64)>,
    ) -> Self {
        self.effect = Some(effect);
        if let Some((hash, len)) = written {
            self.written_hash = Some(hash);
            self.written_byte_length = Some(len);
        }
        self
    }

    /// Attach the intended-bytes identity (§8.19.1): every `unknown`-effect
    /// error must let the caller record a non-null intended hash.
    pub fn with_intent(mut self, hash: String, byte_length: u64) -> Self {
        self.intent_hash = Some(hash);
        self.intent_byte_length = Some(byte_length);
        self
    }

    /// Attach the pre-mutation target bytes identity observed by the writer.
    pub fn with_old_hash(mut self, hash: Option<String>) -> Self {
        self.old_hash = hash;
        self
    }
}

/// Success response of the encoded byte writers (§8.18.1 native contract):
/// the decoded file plus the exact bytes that landed on disk and whether an
/// atomic temp-file replace was used. `intent_hash` repeats the intended
/// bytes identity (equal to `written_hash` on success) so every settled write
/// reports the full fact set required by §8.19.1.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWriteAck {
    pub file: WorkspaceFile,
    pub written_hash: String,
    pub written_byte_length: u64,
    pub intent_hash: String,
    /// Pre-mutation target bytes hash observed by the writer, when the target
    /// existed (null for a fresh create).
    pub old_hash: Option<String>,
    pub atomic_replace_used: bool,
}

/// Classify a filesystem failure from the byte-writer path. Only
/// `PermissionDenied` is promoted to `permission`; everything else stays `io`.
fn classify_io_error(operation: &str, error: &std::io::Error) -> WorkspaceWriteError {
    let kind = if error.kind() == std::io::ErrorKind::PermissionDenied {
        WorkspaceWriteErrorKind::Permission
    } else {
        WorkspaceWriteErrorKind::Io
    };
    WorkspaceWriteError::new(kind, format!("{operation}: {error}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCompactChain {
    pub path: String,
    pub entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRootCandidate {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    pub repo_root: String,
    pub root_ids: Vec<String>,
    pub is_submodule: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskExecution {
    pub executable: String,
    pub args: Vec<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A task-scoped environment value. The terminal renderer applies it only to
/// the launched task, rather than mutating the user's interactive shell.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskEnvironmentVariable {
    pub value: String,
    /// `append` preserves an existing value (used for MAVEN_OPTS).
    pub mode: String,
}

type WorkspaceTaskEnvironment = BTreeMap<String, WorkspaceTaskEnvironmentVariable>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTask {
    pub id: String,
    pub label: String,
    pub command: String,
    pub cwd: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<WorkspaceTaskExecution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<WorkspaceTaskEnvironment>,
}

/// A runnable Java `public static void main` entry point discovered from source.
///
/// This is intentionally independent from java-debug/jdtls bundles: Run must
/// keep working with only a JDK plus the project's Maven/Gradle wrapper.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JavaRunTarget {
    pub id: String,
    pub label: String,
    pub main_class: String,
    pub file_path: String,
    pub command: String,
    pub cwd: String,
    /// `maven`, `gradle`, or `source-file`.
    pub build_system: String,
    /// Workspace-relative build/module directory (`.` for the root project).
    pub module_path: String,
    pub execution: WorkspaceTaskExecution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<WorkspaceTaskEnvironment>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceToolConfig {
    #[serde(default, alias = "mvn", alias = "mavenExecutable")]
    pub maven: Option<String>,
    #[serde(default, alias = "gradleExecutable")]
    pub gradle: Option<String>,
    /// Explicit JVM options for Maven `exec:java`, configured per workspace.
    #[serde(default)]
    pub maven_jvm_args: Vec<String>,
    /// Omitted means enabled, preserving automatic support for existing users.
    #[serde(default)]
    pub inherit_maven_arg_line: Option<bool>,
    #[serde(default)]
    pub cargo: Option<String>,
    #[serde(default)]
    pub go: Option<String>,
    #[serde(default)]
    pub node: Option<String>,
    #[serde(default)]
    pub npm: Option<String>,
    #[serde(default)]
    pub pnpm: Option<String>,
    #[serde(default)]
    pub yarn: Option<String>,
    #[serde(default)]
    pub python: Option<String>,
    #[serde(default)]
    pub uv: Option<String>,
    #[serde(default)]
    pub poetry: Option<String>,
    #[serde(default)]
    pub cmake: Option<String>,
    #[serde(default)]
    pub dotnet: Option<String>,
    #[serde(default)]
    pub sbt: Option<String>,
    #[serde(default)]
    pub swift: Option<String>,
    #[serde(default)]
    pub lldb_dap: Option<String>,
    #[serde(default)]
    pub delve: Option<String>,
    #[serde(default)]
    pub debugpy: Option<String>,
    #[serde(default)]
    pub js_debug: Option<String>,
    #[serde(default)]
    pub netcoredbg: Option<String>,
}

impl WorkspaceToolConfig {
    fn inherits_maven_arg_line(&self) -> bool {
        self.inherit_maven_arg_line.unwrap_or(true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostPlatform {
    Windows,
    Unix,
}

impl HostPlatform {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BuildTool {
    Maven,
    Gradle,
}

impl BuildTool {
    fn name(self) -> &'static str {
        match self {
            Self::Maven => "Maven",
            Self::Gradle => "Gradle",
        }
    }

    fn path_command(self) -> &'static str {
        match self {
            Self::Maven => "mvn",
            Self::Gradle => "gradle",
        }
    }

    fn configured<'a>(self, config: Option<&'a WorkspaceToolConfig>) -> Option<&'a str> {
        match self {
            Self::Maven => config.and_then(|config| config.maven.as_deref()),
            Self::Gradle => config.and_then(|config| config.gradle.as_deref()),
        }
        .map(str::trim)
        .filter(|value| !value.is_empty())
    }

    fn wrapper_names(self, platform: HostPlatform) -> &'static [&'static str] {
        match (self, platform) {
            (Self::Maven, HostPlatform::Windows) => &["mvnw.cmd", "mvnw.bat", "mvnw"],
            (Self::Maven, HostPlatform::Unix) => &["mvnw"],
            (Self::Gradle, HostPlatform::Windows) => &["gradlew.bat", "gradlew.cmd", "gradlew"],
            (Self::Gradle, HostPlatform::Unix) => &["gradlew"],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolSource {
    Wrapper,
    Configured,
    Path,
}

impl ToolSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wrapper => "wrapper",
            Self::Configured => "configured",
            Self::Path => "path",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolResolution {
    tool: BuildTool,
    executable: PathBuf,
    source: ToolSource,
    available: bool,
    diagnostic: Option<String>,
}

impl ToolResolution {
    fn task_runner(&self, platform: HostPlatform) -> String {
        if self.source == ToolSource::Path {
            self.tool.path_command().to_string()
        } else {
            wrapper_command_for(&self.executable, platform)
        }
    }

    fn execution(&self, args: &[&str]) -> WorkspaceTaskExecution {
        self.execution_owned(args.iter().map(|arg| (*arg).to_string()).collect())
    }

    fn execution_owned(&self, args: Vec<String>) -> WorkspaceTaskExecution {
        WorkspaceTaskExecution {
            executable: path_to_string(&self.executable),
            args,
            source: self.source.as_str().to_string(),
            error: self.diagnostic.clone(),
        }
    }

    fn require_available(&self) -> Result<(), String> {
        if self.available {
            Ok(())
        } else {
            Err(self.diagnostic.clone().unwrap_or_else(|| {
                format!("{} executable could not be resolved", self.tool.name())
            }))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolLaunchPlan {
    program: String,
    args: Vec<String>,
}

/// Grouped task view for the Build panel task tree (M7 F-2). Unlike the flat
/// `workspace_detect_tasks`, tasks are bucketed by source and Maven/Gradle carry
/// their full lifecycle / common tasks rather than the two-entry Run-tab subset.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskGroup {
    /// Source key (also the group label), e.g. "Maven", "Gradle", "package.json".
    pub source: String,
    pub tasks: Vec<WorkspaceTask>,
}
