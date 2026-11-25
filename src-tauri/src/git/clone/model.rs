use serde::{Deserialize, Serialize};

/// Fixed vault entry used to offer "Use the saved token" on later clones.
pub(super) const GIT_CLONE_TOKEN_ID: &str = "git-clone-token-v1";
pub(super) const DEFAULT_TOKEN_USERNAME: &str = "x-access-token";
pub(super) const PROGRESS_EVENT: &str = "git-clone-progress";
pub(super) const MAX_PROGRESS_LINE: usize = 500;
pub(super) const MAX_REMOTE_BRANCHES: usize = 200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneRequest {
    pub task_id: String,
    pub url: String,
    pub destination: String,
    pub workspace_name: String,
    pub branch: Option<String>,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub proxy_mode: String,
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub token: Option<String>,
    pub token_username: Option<String>,
    pub use_saved_token: bool,
    pub remember_token: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneResult {
    pub task_id: String,
    pub destination: String,
    pub repo_root: String,
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    pub head_oid: Option<String>,
    pub remote_url: String,
    pub duration_ms: u64,
    pub token_remembered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneProgress {
    pub task_id: String,
    pub phase: String,
    pub percent: Option<f64>,
    pub indeterminate: bool,
    pub message: String,
    pub objects_done: Option<u64>,
    pub objects_total: Option<u64>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn progress_payload(
    task_id: &str,
    phase: &str,
    percent: Option<f64>,
    message: String,
    objects_done: Option<u64>,
    objects_total: Option<u64>,
) -> GitCloneProgress {
    GitCloneProgress {
        task_id: task_id.to_string(),
        phase: phase.to_string(),
        percent,
        indeterminate: percent.is_none(),
        message: message.chars().take(MAX_PROGRESS_LINE).collect(),
        objects_done,
        objects_total,
    }
}
