mod worktree_commands;
pub use worktree_commands::*;
mod remote_commands;
pub use remote_commands::*;
mod branch_commands;
pub use branch_commands::*;
mod history_commands;
pub use history_commands::*;
mod operation_commands;
pub use operation_commands::*;
mod repository;
use repository::*;
mod ignore;
use ignore::*;
mod queries;
use queries::*;
mod process;
use process::*;
mod blobs;
use blobs::*;
mod operations;
use operations::*;
#[cfg(test)]
mod tests;

use crate::state::AppState;
use crate::vault::Vault;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProbeResult {
    pub path: String,
    pub git_available: bool,
    pub is_repo: bool,
    pub repo_root: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub repo_root: String,
    pub current_branch: Option<String>,
    pub head_oid: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitChange>,
    pub remotes: Vec<GitRemote>,
    pub branches: Vec<GitBranch>,
    pub stashes: Vec<GitStashEntry>,
    pub tags: Vec<GitTag>,
    pub settings: GitRepoSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: Option<String>,
    pub username: Option<String>,
    pub token_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoSettings {
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub pull_rebase: Option<String>,
    pub push_default: Option<String>,
    pub core_autocrlf: Option<String>,
    pub core_filemode: Option<String>,
    pub commit_gpgsign: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub full_name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
    pub oid: Option<String>,
    pub subject: Option<String>,
    /// Tip committer date (iso-strict) for sort/recent UI.
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogFilter {
    pub limit: Option<u32>,
    pub skip: Option<u32>,
    pub author: Option<String>,
    pub grep: Option<String>,
    pub path: Option<String>,
    pub all: Option<bool>,
    pub after: Option<String>,
    pub before: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntry {
    pub selector: String,
    pub oid: String,
    pub date: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    pub name: String,
    pub oid: String,
    pub subject: Option<String>,
    pub annotated: bool,
    /// Creator/tagger date (iso-strict) for sort/recent UI.
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteAuthResult {
    pub username: Option<String>,
    pub token_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlobPair {
    pub path: String,
    pub old_path: Option<String>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub old_exists: bool,
    pub new_exists: bool,
    pub binary: bool,
    pub image: bool,
    pub old_image_b64: Option<String>,
    pub new_image_b64: Option<String>,
    pub oversize: bool,
    pub old_size: u64,
    pub new_size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line: u32,
    pub commit: String,
    pub author: String,
    pub author_mail: Option<String>,
    pub author_time: i64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationState {
    /// "merge" | "cherryPick" | "revert" | "rebase" | "none"
    pub kind: String,
    pub conflicted_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitIgnoreResult {
    pub rule: String,
    pub gitignore_path: String,
    pub added: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitResetMode {
    Soft,
    Mixed,
    Hard,
}

const AUTH_SECTION: &str = "taomni-auth";

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn non_empty_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    let filtered: Vec<String> = paths
        .into_iter()
        .filter_map(|p| non_empty_string(&p))
        .collect();
    if filtered.is_empty() {
        Err("at least one path is required".to_string())
    } else {
        Ok(filtered)
    }
}

fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
