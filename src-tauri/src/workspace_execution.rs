//! Structured multi-language Build/Run/Debug discovery for Code Workspace.
//!
//! Providers in this module are deliberately evidence-driven: a manifest owns a
//! project, commands are represented as argv rather than shell fragments, and a
//! debug configuration is enabled only when its adapter can be resolved.

mod manifests;
mod model_builder;
pub use manifests::*;
mod tools;
use tools::*;
mod shared_config;
use shared_config::*;
mod shared_providers;
use shared_providers::*;
mod shared_resolver;
use shared_resolver::*;
mod cargo;
use cargo::*;
mod go;
use go::*;
mod node;
use node::*;
mod python;
use python::*;
mod cmake;
use cmake::*;
mod dotnet;
use dotnet::*;
mod jvm;
use jvm::*;
mod swift;
use swift::*;
#[cfg(test)]
mod tests;

use crate::workspace::WorkspaceToolConfig;
use ignore::{DirEntry, WalkBuilder};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_MANIFEST_DEPTH: usize = 8;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const SHARED_RUN_CONFIG_RELATIVE_PATH: &str = ".taomni/run-configurations.json";
const SHARED_RUN_CONFIG_VERSION: u64 = 2;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub display: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolProbe {
    pub id: String,
    pub label: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub install_hint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModel {
    pub id: String,
    pub provider: String,
    pub root: String,
    pub manifest: String,
    pub module: String,
    pub module_id: String,
    pub languages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_level: Option<String>,
    pub toolchain: String,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleModel {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub root: String,
    pub manifest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_level: Option<String>,
    pub source_set_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_module_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub child_module_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub module_dependencies: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSetModel {
    pub id: String,
    pub project_id: String,
    pub module_id: String,
    pub name: String,
    pub kind: String,
    pub roots: Vec<String>,
    pub generated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompileArtifact {
    pub id: String,
    pub project_id: String,
    pub module_id: String,
    pub target_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub resolution: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildTarget {
    pub id: String,
    pub project_id: String,
    pub module_id: String,
    pub label: String,
    pub kind: String,
    pub command: ExecutionCommand,
    pub depends_on: Vec<String>,
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunConfiguration {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub kind: String,
    pub command: ExecutionCommand,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    pub pre_launch_targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_configuration_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argument_strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_modes: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_configuration_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_parallel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_stop_on_failure: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfiguration {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub adapter_id: String,
    pub request: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    pub pre_launch_targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    pub launch_config: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_configuration_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_parallel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_stop_on_failure: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExecutionModel {
    pub projects: Vec<ProjectModel>,
    pub modules: Vec<ModuleModel>,
    pub source_sets: Vec<SourceSetModel>,
    pub build_targets: Vec<BuildTarget>,
    pub compile_artifacts: Vec<CompileArtifact>,
    pub run_configurations: Vec<RunConfiguration>,
    pub debug_configurations: Vec<DebugConfiguration>,
    pub tools: Vec<ToolProbe>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedConfigurationFile {
    #[serde(default)]
    version: Option<u64>,
    #[serde(default)]
    configurations: Vec<SharedConfiguration>,
    /// Version 1 used a top-level `runs` array. It is intentionally kept as
    /// raw JSON so migration can accept the old command/object spellings.
    #[serde(default)]
    runs: Vec<Value>,
    #[serde(default)]
    templates: BTreeMap<String, SharedTemplate>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedTemplate {
    #[serde(flatten)]
    patch: SharedConfigurationPatch,
    #[serde(default)]
    platforms: BTreeMap<String, SharedConfigurationPatch>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedConfiguration {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default, alias = "baseConfigurationId")]
    base: Option<String>,
    #[serde(default)]
    template: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    source_file: Option<String>,
    #[serde(default, alias = "preLaunchTargets")]
    before_launch: Option<Vec<String>>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    run: Option<SharedRunSpec>,
    #[serde(default)]
    debug: Option<SharedDebugSpec>,
    #[serde(default)]
    compound: Option<SharedCompoundSpec>,
    #[serde(default)]
    platforms: BTreeMap<String, SharedConfigurationPatch>,
    // v1 accepted the run fields directly on each entry. Keeping these
    // optional fields makes migration deterministic and preserves hand-written
    // files from early Code Workspace previews.
    #[serde(default)]
    executable: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    display: Option<String>,
    #[serde(default)]
    runtime_options: Option<Vec<String>>,
    #[serde(default)]
    env_file: Option<String>,
    #[serde(default)]
    argument_strategy: Option<String>,
    #[serde(default)]
    environment_modes: Option<BTreeMap<String, String>>,
    #[serde(default)]
    adapter_id: Option<String>,
    #[serde(default)]
    request: Option<String>,
    #[serde(default)]
    launch_config: Option<Value>,
    #[serde(default, alias = "debugConfigurationId")]
    debug_reference: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedConfigurationPatch {
    #[serde(default)]
    source_file: Option<String>,
    #[serde(default)]
    before_launch: Option<Vec<String>>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    run: Option<SharedRunSpec>,
    #[serde(default)]
    debug: Option<SharedDebugSpec>,
    #[serde(default)]
    compound: Option<SharedCompoundSpec>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedCompoundSpec {
    configurations: Vec<String>,
    #[serde(default)]
    parallel: Option<bool>,
    #[serde(default)]
    stop_on_failure: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedRunSpec {
    #[serde(default)]
    executable: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    display: Option<String>,
    #[serde(default)]
    runtime_options: Option<Vec<String>>,
    #[serde(default)]
    env_file: Option<String>,
    #[serde(default)]
    argument_strategy: Option<String>,
    #[serde(default)]
    environment_modes: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedDebugSpec {
    #[serde(default)]
    adapter_id: Option<String>,
    #[serde(default)]
    request: Option<String>,
    #[serde(default)]
    available: Option<bool>,
    #[serde(default)]
    launch_config: Option<Value>,
    #[serde(default)]
    env_file: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedSharedConfiguration {
    id: String,
    label: String,
    kind: String,
    project_id: String,
    source_file: Option<String>,
    before_launch: Vec<String>,
    run: Option<ResolvedSharedRun>,
    debug: Option<ResolvedSharedDebug>,
    debug_reference: Option<String>,
    compound: Option<SharedCompoundSpec>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedSharedRun {
    executable: String,
    args: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    display: Option<String>,
    runtime_options: Option<Vec<String>>,
    env_file: Option<String>,
    argument_strategy: Option<String>,
    environment_modes: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedSharedDebug {
    adapter_id: String,
    request: String,
    available: Option<bool>,
    launch_config: Value,
    env_file: Option<String>,
}

#[derive(Default)]
struct ModelBuilder {
    projects: Vec<ProjectModel>,
    modules: Vec<ModuleModel>,
    source_sets: Vec<SourceSetModel>,
    build_targets: Vec<BuildTarget>,
    compile_artifacts: Vec<CompileArtifact>,
    run_configurations: Vec<RunConfiguration>,
    debug_configurations: Vec<DebugConfiguration>,
    tools: BTreeMap<String, ToolProbe>,
    diagnostics: Vec<String>,
}

#[tauri::command]
pub async fn workspace_execution_model(
    repo_root: String,
    active_file: Option<String>,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<WorkspaceExecutionModel, String> {
    // This scan can walk a large workspace and probe installed tools. A sync
    // Tauri command runs on the window thread and also stalls WebView frames.
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_root(&repo_root)?;
        let active = resolve_active(&root, active_file.as_deref());
        detect_execution_model(&root, active.as_deref(), tool_config.as_ref())
    })
    .await
    .map_err(|error| format!("workspace_execution_model: {error}"))?
}
