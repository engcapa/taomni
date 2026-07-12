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

#[tauri::command]
pub async fn git_probe_path(path: String) -> Result<GitProbeResult, String> {
    blocking(move || probe_path(&path)).await
}

#[tauri::command]
pub async fn git_init_repo(path: String) -> Result<GitProbeResult, String> {
    blocking(move || {
        let path_buf = git_cwd_path(&path);
        run_git_in(Some(&path_buf), ["init"])?;
        probe_path(&path)
    })
    .await
}

#[tauri::command]
pub async fn git_snapshot(repo_root: String) -> Result<GitSnapshot, String> {
    blocking(move || snapshot(&PathBuf::from(repo_root))).await
}

#[tauri::command]
pub async fn git_diff(
    repo_root: String,
    path: Option<String>,
    staged: bool,
    commit: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let mut args: Vec<String> = if let Some(commit) = commit {
            vec![
                "show".into(),
                "--format=".into(),
                "--patch".into(),
                "--find-renames".into(),
                commit,
            ]
        } else if staged {
            vec!["diff".into(), "--cached".into(), "--find-renames".into()]
        } else {
            vec!["diff".into(), "--find-renames".into()]
        };
        if let Some(path) = path.filter(|p| !p.trim().is_empty()) {
            args.push("--".into());
            args.push(path);
        }
        run_git_strings(Some(&root), args)
    })
    .await
}

/// Fetch the old/new byte content of a path for a structured (side-by-side) diff.
///
/// `old_ref` / `new_ref` accept the special tokens `:WORKTREE` (read the file from
/// disk), `:INDEX` (the staged blob), an empty string (the side does not exist), or
/// any revision (`HEAD`, a branch, a commit) resolved as `<rev>:<path>`.
#[tauri::command]
pub async fn git_blob_pair(
    repo_root: String,
    path: String,
    old_path: Option<String>,
    old_ref: String,
    new_ref: String,
) -> Result<GitBlobPair, String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        ensure_repo(&root)?;
        let old_target = old_path
            .clone()
            .and_then(|p| non_empty_string(&p))
            .unwrap_or_else(|| path.clone());
        let old_blob = read_blob(&root, &old_ref, &old_target)?;
        let new_blob = read_blob(&root, &new_ref, &path)?;
        Ok(build_blob_pair(path, old_path, old_blob, new_blob))
    })
    .await
}

/// Read line attribution from Git's stable porcelain format. Line numbers are
/// one-based to match `git blame -L` and are bounded to keep editor requests
/// cheap even when called with an accidental large range.
#[tauri::command]
pub async fn git_blame_lines(
    repo_root: String,
    path: String,
    start_line: u32,
    end_line: u32,
) -> Result<Vec<GitBlameLine>, String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        ensure_repo(&root)?;
        if path.trim().is_empty() {
            return Err("Git blame path is required".into());
        }
        if start_line == 0 || end_line < start_line {
            return Err("Git blame line range is invalid".into());
        }
        if end_line - start_line > 499 {
            return Err("Git blame range cannot exceed 500 lines".into());
        }
        let range = format!("{start_line},{end_line}");
        let raw = run_git_strings(
            Some(&root),
            vec![
                "blame".into(),
                "--line-porcelain".into(),
                "-L".into(),
                range,
                "--".into(),
                path,
            ],
        )?;
        Ok(parse_blame_porcelain(&raw))
    })
    .await
}

#[tauri::command]
pub async fn git_stage(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let mut args = vec!["add".to_string(), "--".to_string()];
        args.extend(non_empty_paths(paths)?);
        run_git_strings(Some(&root), args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let mut args = vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
        ];
        args.extend(non_empty_paths(paths)?);
        run_git_strings(Some(&root), args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_discard(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let mut args = vec![
            "restore".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        args.extend(non_empty_paths(paths)?);
        run_git_strings(Some(&root), args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_clean_untracked(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let mut args = vec!["clean".to_string(), "-f".to_string(), "--".to_string()];
        args.extend(non_empty_paths(paths)?);
        run_git_strings(Some(&root), args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_ignore_path(
    repo_root: String,
    path: String,
    directory: bool,
) -> Result<GitIgnoreResult, String> {
    blocking(move || add_git_ignore_rule(Path::new(&repo_root), &path, directory)).await
}

#[tauri::command]
pub async fn git_commit(
    repo_root: String,
    message: String,
    amend: bool,
    paths: Option<Vec<String>>,
) -> Result<(), String> {
    blocking(move || commit_changes(&PathBuf::from(repo_root), &message, amend, paths)).await
}

/// Create a commit. When `paths` is `Some` and non-empty, only those paths are
/// committed: they are staged first (covering modified, untracked, deleted and
/// renamed states) and `commit --only -- <paths>` keeps any other already-staged
/// files out of this commit, matching IntelliJ's "commit checked items" behaviour.
fn commit_changes(
    root: &Path,
    message: &str,
    amend: bool,
    paths: Option<Vec<String>>,
) -> Result<(), String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("commit message is required".to_string());
    }
    let selected = paths
        .map(|p| {
            p.into_iter()
                .filter_map(|s| non_empty_string(&s))
                .collect::<Vec<_>>()
        })
        .filter(|p| !p.is_empty());
    if let Some(selected) = &selected {
        let mut add_args = vec!["add".to_string(), "--all".to_string(), "--".to_string()];
        add_args.extend(selected.clone());
        run_git_strings(Some(root), add_args)?;
    }
    let mut args = vec!["commit".to_string(), "-m".to_string(), trimmed.to_string()];
    if amend {
        args.push("--amend".into());
    }
    if let Some(selected) = selected {
        args.push("--only".into());
        args.push("--".into());
        args.extend(selected);
    }
    run_git_strings(Some(root), args).map(|_| ())
}

#[tauri::command]
pub async fn git_fetch(
    repo_root: String,
    remote: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vault = state.vault.clone();
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let remote = remote.filter(|s| !s.trim().is_empty());
        let mut args = vec!["fetch".to_string(), "--prune".to_string()];
        if let Some(remote) = &remote {
            args.push(remote.clone());
        }
        run_git_authed(&root, args, vault, remote.as_deref()).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_pull(
    repo_root: String,
    remote: Option<String>,
    branch: Option<String>,
    rebase: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vault = state.vault.clone();
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let remote = remote.filter(|s| !s.trim().is_empty());
        let branch = branch.filter(|s| !s.trim().is_empty());
        let args = build_pull_args(&root, remote.as_deref(), branch.as_deref(), rebase)?;
        run_git_authed(&root, args, vault, remote.as_deref()).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_push(
    repo_root: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: bool,
    force_with_lease: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vault = state.vault.clone();
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let remote = remote.filter(|s| !s.trim().is_empty());
        let mut args = vec!["push".to_string()];
        if set_upstream {
            args.push("-u".into());
        }
        if force_with_lease {
            args.push("--force-with-lease".into());
        }
        if let Some(remote) = &remote {
            args.push(remote.clone());
            if let Some(branch) = branch.filter(|s| !s.trim().is_empty()) {
                args.push(branch);
            }
        }
        run_git_authed(&root, args, vault, remote.as_deref()).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_checkout_branch(repo_root: String, branch: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("branch", &branch)?;
        run_git_in(Some(Path::new(&repo_root)), ["checkout", branch.as_str()]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(
    repo_root: String,
    branch: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<(), String> {
    blocking(move || {
        require_non_empty("branch", &branch)?;
        let root = PathBuf::from(repo_root);
        let mut args = vec![if checkout { "checkout" } else { "branch" }.to_string()];
        if checkout {
            args.push("-b".into());
        }
        args.push(branch);
        if let Some(start) = start_point.filter(|s| !s.trim().is_empty()) {
            args.push(start);
        }
        run_git_strings(Some(&root), args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_delete_branch(
    repo_root: String,
    branch: String,
    force: bool,
) -> Result<(), String> {
    blocking(move || {
        require_non_empty("branch", &branch)?;
        let flag = if force { "-D" } else { "-d" };
        run_git_in(
            Some(Path::new(&repo_root)),
            ["branch", flag, branch.as_str()],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_merge_branch(repo_root: String, branch: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("branch", &branch)?;
        run_git_in(Some(Path::new(&repo_root)), ["merge", branch.as_str()]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_rename_branch(
    repo_root: String,
    branch: String,
    new_name: String,
) -> Result<(), String> {
    blocking(move || {
        require_non_empty("branch", &branch)?;
        require_non_empty("new name", &new_name)?;
        run_git_in(
            Some(Path::new(&repo_root)),
            ["branch", "-m", branch.as_str(), new_name.as_str()],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_set_upstream(
    repo_root: String,
    branch: String,
    upstream: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        require_non_empty("branch", &branch)?;
        let root = PathBuf::from(repo_root);
        match upstream.and_then(|s| non_empty_string(&s)) {
            Some(upstream) => run_git_strings(
                Some(&root),
                vec![
                    "branch".into(),
                    "--set-upstream-to".into(),
                    upstream,
                    branch,
                ],
            )
            .map(|_| ()),
            None => run_git_strings(
                Some(&root),
                vec!["branch".into(), "--unset-upstream".into(), branch],
            )
            .map(|_| ()),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_create_tag(
    repo_root: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        require_non_empty("tag name", &name)?;
        let root = PathBuf::from(repo_root);
        let mut args = vec!["tag".to_string()];
        if let Some(message) = message.and_then(|s| non_empty_string(&s)) {
            args.push("-a".into());
            args.push(name.clone());
            args.push("-m".into());
            args.push(message);
        } else {
            args.push(name.clone());
        }
        if let Some(target) = target.and_then(|s| non_empty_string(&s)) {
            args.push(target);
        }
        run_git_strings(Some(&root), args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_delete_tag(repo_root: String, name: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("tag name", &name)?;
        run_git_in(Some(Path::new(&repo_root)), ["tag", "-d", name.as_str()]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_push_tag(
    repo_root: String,
    remote: Option<String>,
    name: String,
    delete: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vault = state.vault.clone();
    blocking(move || {
        require_non_empty("tag name", &name)?;
        let root = PathBuf::from(repo_root);
        let remote = remote.filter(|s| !s.trim().is_empty());
        let mut args = vec!["push".to_string()];
        args.push(remote.clone().unwrap_or_else(|| "origin".into()));
        if delete {
            args.push("--delete".into());
        }
        args.push(format!("refs/tags/{name}"));
        run_git_authed(&root, args, vault, remote.as_deref()).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_checkout_tag(repo_root: String, name: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("tag name", &name)?;
        run_git_in(Some(Path::new(&repo_root)), ["checkout", name.as_str()]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_log(
    repo_root: String,
    limit: Option<u32>,
    filter: Option<GitLogFilter>,
) -> Result<Vec<GitLogEntry>, String> {
    blocking(move || {
        let mut filter = filter.unwrap_or_default();
        if filter.limit.is_none() {
            filter.limit = Some(limit.unwrap_or(120));
        }
        list_log(&PathBuf::from(repo_root), &filter)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_files(repo_root: String, oid: String) -> Result<Vec<GitChange>, String> {
    blocking(move || {
        require_non_empty("oid", &oid)?;
        let out = run_git_strings(
            Some(Path::new(&repo_root)),
            vec![
                "show".into(),
                "--name-status".into(),
                "--format=".into(),
                "--find-renames".into(),
                oid,
            ],
        )?;
        Ok(parse_name_status(&out))
    })
    .await
}

#[tauri::command]
pub async fn git_compare(
    repo_root: String,
    ref_a: String,
    ref_b: String,
) -> Result<Vec<GitChange>, String> {
    blocking(move || {
        require_non_empty("ref_a", &ref_a)?;
        require_non_empty("ref_b", &ref_b)?;
        let out = run_git_strings(
            Some(Path::new(&repo_root)),
            vec![
                "diff".into(),
                "--name-status".into(),
                "--find-renames".into(),
                ref_a,
                ref_b,
            ],
        )?;
        Ok(parse_name_status(&out))
    })
    .await
}

#[tauri::command]
pub async fn git_reset(
    repo_root: String,
    target: String,
    mode: GitResetMode,
) -> Result<(), String> {
    blocking(move || {
        require_non_empty("target", &target)?;
        let flag = match mode {
            GitResetMode::Soft => "--soft",
            GitResetMode::Mixed => "--mixed",
            GitResetMode::Hard => "--hard",
        };
        run_git_in(
            Some(Path::new(&repo_root)),
            ["reset", flag, target.as_str()],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_revert(repo_root: String, commit: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("commit", &commit)?;
        run_git_in(Some(Path::new(&repo_root)), ["revert", commit.as_str()]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_cherry_pick(repo_root: String, commit: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("commit", &commit)?;
        run_git_in(
            Some(Path::new(&repo_root)),
            ["cherry-pick", commit.as_str()],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_cherry_pick_continue(repo_root: String) -> Result<(), String> {
    blocking(move || {
        run_git_in(Some(Path::new(&repo_root)), ["cherry-pick", "--continue"]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_cherry_pick_abort(repo_root: String) -> Result<(), String> {
    blocking(move || {
        run_git_in(Some(Path::new(&repo_root)), ["cherry-pick", "--abort"]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_operation_state(repo_root: String) -> Result<GitOperationState, String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        ensure_repo(&root)?;
        let kind = detect_operation(&root);
        Ok(GitOperationState {
            conflicted_paths: conflicted_paths(&root),
            kind,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_operation_continue(repo_root: String, kind: String) -> Result<(), String> {
    blocking(move || {
        let cmd = operation_command(&kind)?;
        // GIT_EDITOR=true keeps the prepared commit message without an interactive editor.
        run_git_no_editor(Path::new(&repo_root), vec![cmd.into(), "--continue".into()]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_operation_abort(repo_root: String, kind: String) -> Result<(), String> {
    blocking(move || {
        let cmd = operation_command(&kind)?;
        run_git_in(Some(Path::new(&repo_root)), [cmd, "--abort"]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_rebase(repo_root: String, onto: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("onto", &onto)?;
        run_git_no_editor(Path::new(&repo_root), vec!["rebase".into(), onto]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_rebase_skip(repo_root: String) -> Result<(), String> {
    blocking(move || run_git_in(Some(Path::new(&repo_root)), ["rebase", "--skip"]).map(|_| ()))
        .await
}

#[tauri::command]
pub async fn git_resolve_conflict(
    repo_root: String,
    path: String,
    side: String,
) -> Result<(), String> {
    blocking(move || {
        require_non_empty("path", &path)?;
        let root = PathBuf::from(repo_root);
        let flag = match side.as_str() {
            "ours" => "--ours",
            "theirs" => "--theirs",
            other => return Err(format!("unknown conflict side: {other}")),
        };
        run_git_strings(
            Some(&root),
            vec!["checkout".into(), flag.into(), "--".into(), path.clone()],
        )?;
        run_git_strings(Some(&root), vec!["add".into(), "--".into(), path]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_stash_save(
    repo_root: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let mut args = vec!["stash".to_string(), "push".to_string()];
        if include_untracked {
            args.push("--include-untracked".into());
        }
        if let Some(message) = message.filter(|s| !s.trim().is_empty()) {
            args.push("-m".into());
            args.push(message);
        }
        run_git_strings(Some(&root), args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_stash_list(repo_root: String) -> Result<Vec<GitStashEntry>, String> {
    blocking(move || list_stashes(&PathBuf::from(repo_root))).await
}

#[tauri::command]
pub async fn git_stash_show(repo_root: String, selector: String) -> Result<String, String> {
    blocking(move || {
        require_non_empty("selector", &selector)?;
        run_git_in(
            Some(Path::new(&repo_root)),
            ["stash", "show", "--patch", selector.as_str()],
        )
    })
    .await
}

#[tauri::command]
pub async fn git_stash_apply(repo_root: String, selector: String, pop: bool) -> Result<(), String> {
    blocking(move || {
        require_non_empty("selector", &selector)?;
        let action = if pop { "pop" } else { "apply" };
        run_git_in(
            Some(Path::new(&repo_root)),
            ["stash", action, selector.as_str()],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_stash_drop(repo_root: String, selector: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("selector", &selector)?;
        run_git_in(
            Some(Path::new(&repo_root)),
            ["stash", "drop", selector.as_str()],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_set_remote(
    repo_root: String,
    name: String,
    fetch_url: String,
    push_url: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        require_non_empty("remote name", &name)?;
        require_non_empty("remote URL", &fetch_url)?;
        let root = PathBuf::from(repo_root);
        let existing = list_remote_names(&root)?;
        if existing.iter().any(|item| item == &name) {
            run_git_in(
                Some(&root),
                ["remote", "set-url", name.as_str(), fetch_url.as_str()],
            )?;
        } else {
            run_git_in(
                Some(&root),
                ["remote", "add", name.as_str(), fetch_url.as_str()],
            )?;
        }
        if let Some(push_url) = push_url.filter(|s| !s.trim().is_empty()) {
            run_git_in(
                Some(&root),
                [
                    "remote",
                    "set-url",
                    "--push",
                    name.as_str(),
                    push_url.as_str(),
                ],
            )?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_delete_remote(repo_root: String, name: String) -> Result<(), String> {
    blocking(move || {
        require_non_empty("remote name", &name)?;
        run_git_in(
            Some(Path::new(&repo_root)),
            ["remote", "remove", name.as_str()],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_save_settings(repo_root: String, settings: GitRepoSettings) -> Result<(), String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        set_optional_config(&root, "user.name", settings.user_name)?;
        set_optional_config(&root, "user.email", settings.user_email)?;
        set_optional_config(&root, "http.proxy", settings.http_proxy)?;
        set_optional_config(&root, "https.proxy", settings.https_proxy)?;
        set_optional_config(&root, "pull.rebase", settings.pull_rebase)?;
        set_optional_config(&root, "push.default", settings.push_default)?;
        set_optional_config(&root, "core.autocrlf", settings.core_autocrlf)?;
        set_optional_config(&root, "core.filemode", settings.core_filemode)?;
        set_optional_config(&root, "commit.gpgsign", settings.commit_gpgsign)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_save_remote_auth(
    repo_root: String,
    remote: String,
    username: Option<String>,
    token: Option<String>,
    clear_token: bool,
    state: State<'_, AppState>,
) -> Result<GitRemoteAuthResult, String> {
    let vault = state.vault.clone();
    blocking(move || {
        require_non_empty("remote", &remote)?;
        let root = PathBuf::from(repo_root);
        let username = username.and_then(|s| non_empty_string(&s));
        set_optional_config(
            &root,
            &remote_auth_key(&remote, "username"),
            username.clone(),
        )?;

        let token_ref = if clear_token {
            unset_config(&root, &remote_auth_key(&remote, "tokenRef"))?;
            None
        } else if let Some(token) = token.and_then(|s| non_empty_string(&s)) {
            let result = vault.put(
                "git-token",
                &format!("Git token for {remote}"),
                token.as_str(),
            )?;
            set_optional_config(
                &root,
                &remote_auth_key(&remote, "tokenRef"),
                Some(result.reference.clone()),
            )?;
            Some(result.reference)
        } else {
            get_config(&root, &remote_auth_key(&remote, "tokenRef"))
        };

        Ok(GitRemoteAuthResult {
            username,
            token_ref,
        })
    })
    .await
}

fn snapshot(root: &Path) -> Result<GitSnapshot, String> {
    ensure_repo(root)?;
    let status = run_git_in(Some(root), ["status", "--short", "--branch", "-uall"])?;
    let (current_branch, detached, changes) = parse_status(&status);
    let head_oid = run_git_in(Some(root), ["rev-parse", "--short", "HEAD"])
        .ok()
        .and_then(|s| non_empty_string(&s));
    let upstream = run_git_in(
        Some(root),
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .and_then(|s| non_empty_string(&s));
    let (ahead, behind) = ahead_behind(root, upstream.as_deref());
    Ok(GitSnapshot {
        repo_root: root.to_string_lossy().to_string(),
        current_branch,
        head_oid,
        detached,
        upstream,
        ahead,
        behind,
        changes,
        remotes: list_remotes(root)?,
        branches: list_branches(root)?,
        stashes: list_stashes(root)?,
        tags: list_tags(root).unwrap_or_default(),
        settings: load_settings(root),
    })
}

fn probe_path(path: &str) -> Result<GitProbeResult, String> {
    let path_buf = git_cwd_path(path);
    if !git_available() {
        return Ok(GitProbeResult {
            path: path.to_string(),
            git_available: false,
            is_repo: false,
            repo_root: None,
            error: Some("git executable was not found".to_string()),
        });
    }

    match run_git_in(Some(&path_buf), ["rev-parse", "--show-toplevel"]) {
        Ok(root) => Ok(GitProbeResult {
            path: path.to_string(),
            git_available: true,
            is_repo: true,
            repo_root: non_empty_string(&root),
            error: None,
        }),
        Err(error) => Ok(GitProbeResult {
            path: path.to_string(),
            git_available: true,
            is_repo: false,
            repo_root: None,
            error: Some(error),
        }),
    }
}

fn git_cwd_path(path: &str) -> PathBuf {
    PathBuf::from(normalize_windows_shell_path(path).unwrap_or_else(|| path.to_string()))
}

#[cfg(windows)]
fn normalize_windows_shell_path(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }

    let drive_uri_path = path.as_bytes();
    if drive_uri_path.len() >= 3
        && drive_uri_path[0] == b'/'
        && drive_uri_path[2] == b':'
        && drive_uri_path[1].is_ascii_alphabetic()
    {
        let rest = match &path[3..] {
            "" => "/",
            rest => rest,
        };
        return Some(
            format!(
                "{}:{}",
                (drive_uri_path[1] as char).to_ascii_uppercase(),
                rest
            )
            .replace('/', "\\"),
        );
    }

    let mut parts = path.split('/');
    if parts.next() == Some("") {
        match (parts.next(), parts.next()) {
            (Some(drive), None) if is_single_drive_letter(drive) => {
                return Some(format!("{}:\\", drive.to_ascii_uppercase()));
            }
            (Some(drive), Some(rest)) if is_single_drive_letter(drive) => {
                let suffix = std::iter::once(rest)
                    .chain(parts)
                    .collect::<Vec<_>>()
                    .join("\\");
                return Some(format!("{}:\\{}", drive.to_ascii_uppercase(), suffix));
            }
            (Some("cygdrive"), Some(drive)) if is_single_drive_letter(drive) => {
                let suffix = parts.collect::<Vec<_>>().join("\\");
                return Some(if suffix.is_empty() {
                    format!("{}:\\", drive.to_ascii_uppercase())
                } else {
                    format!("{}:\\{}", drive.to_ascii_uppercase(), suffix)
                });
            }
            _ => {}
        }
    }

    None
}

#[cfg(not(windows))]
fn normalize_windows_shell_path(_path: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn is_single_drive_letter(value: &str) -> bool {
    value.len() == 1 && value.as_bytes()[0].is_ascii_alphabetic()
}

fn git_available() -> bool {
    new_git_command()
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn ensure_repo(root: &Path) -> Result<(), String> {
    run_git_in(Some(root), ["rev-parse", "--git-dir"]).map(|_| ())
}

fn normalize_git_ignore_target(path: &str) -> Result<String, String> {
    let normalized = path.trim().replace('\\', "/");
    let normalized = normalized.trim_start_matches("./").trim_start_matches('/');
    if normalized.is_empty() {
        return Err("Git ignore path is required".into());
    }
    if normalized.contains('\0') {
        return Err("Git ignore path contains an invalid null byte".into());
    }
    if normalized
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err("Git ignore path must stay within the repository".into());
    }
    Ok(normalized.to_string())
}

fn escape_git_ignore_literal(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len() + 1);
    for ch in path.chars() {
        if matches!(ch, '\\' | '!' | '*' | '?' | '[' | ']' | '#' | ' ') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn git_path_matches_ignore(root: &Path, path: &str) -> Result<bool, String> {
    let mut command = new_git_command();
    command
        .current_dir(root)
        .arg("check-ignore")
        .arg("--quiet")
        .arg("--")
        .arg(path);
    apply_stable_locale(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    if output.status.success() {
        return Ok(true);
    }
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    command_output(output).map(|_| false)
}

fn git_file_is_tracked(root: &Path, path: &str) -> Result<bool, String> {
    let mut command = new_git_command();
    command
        .current_dir(root)
        .arg("ls-files")
        .arg("--error-unmatch")
        .arg("--")
        .arg(path);
    apply_stable_locale(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    if output.status.success() {
        return Ok(true);
    }
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    command_output(output).map(|_| false)
}

fn add_git_ignore_rule(
    root: &Path,
    path: &str,
    directory: bool,
) -> Result<GitIgnoreResult, String> {
    ensure_repo(root)?;
    let target = normalize_git_ignore_target(path)?;
    if !directory && git_file_is_tracked(root, &target)? {
        return Err(format!(
            "Tracked path cannot be ignored until it is removed from the Git index: {target}"
        ));
    }
    let mut rule = format!("/{}", escape_git_ignore_literal(&target));
    if directory {
        rule.push('/');
    }
    let gitignore = root.join(".gitignore");
    if git_path_matches_ignore(root, &target)? {
        return Ok(GitIgnoreResult {
            rule,
            gitignore_path: gitignore.to_string_lossy().to_string(),
            added: false,
        });
    }

    let existing = match fs::read_to_string(&gitignore) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("read {}: {error}", gitignore.display())),
    };
    if existing
        .lines()
        .any(|line| line.trim_end_matches('\r') == rule)
    {
        return Ok(GitIgnoreResult {
            rule,
            gitignore_path: gitignore.to_string_lossy().to_string(),
            added: false,
        });
    }

    let eol = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut addition = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') && !existing.ends_with('\r') {
        addition.push_str(eol);
    }
    addition.push_str(&rule);
    addition.push_str(eol);
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&gitignore)
        .map_err(|error| format!("open {}: {error}", gitignore.display()))?;
    file.write_all(addition.as_bytes())
        .map_err(|error| format!("write {}: {error}", gitignore.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync {}: {error}", gitignore.display()))?;

    Ok(GitIgnoreResult {
        rule,
        gitignore_path: gitignore.to_string_lossy().to_string(),
        added: true,
    })
}

fn parse_status(output: &str) -> (Option<String>, bool, Vec<GitChange>) {
    let mut current_branch = None;
    let mut detached = false;
    let mut changes = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            if rest.starts_with("HEAD ") || rest.starts_with("HEAD(") {
                detached = true;
            } else {
                let branch_source = rest.strip_prefix("No commits yet on ").unwrap_or(rest);
                let branch = branch_source
                    .split("...")
                    .next()
                    .unwrap_or(branch_source)
                    .trim()
                    .trim_end_matches("[gone]")
                    .trim();
                current_branch = non_empty_string(branch);
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let rest = line[3..].trim();
        let (old_path, path) = match rest.split_once(" -> ") {
            Some((old, new)) => (Some(unquote_path(old)), unquote_path(new)),
            None => (None, unquote_path(rest)),
        };
        let conflict = matches!(
            (x, y),
            ('U', 'U')
                | ('A', 'A')
                | ('D', 'D')
                | ('A', 'U')
                | ('U', 'A')
                | ('D', 'U')
                | ('U', 'D')
        );
        let staged = x != ' ' && x != '?';
        let unstaged = y != ' ' || x == '?';
        let status = if conflict {
            "conflicted"
        } else if x == '?' && y == '?' {
            "untracked"
        } else if x == 'R' || y == 'R' {
            "renamed"
        } else if x == 'D' || y == 'D' {
            "deleted"
        } else if x == 'A' || y == 'A' {
            "added"
        } else {
            "modified"
        };
        changes.push(GitChange {
            path,
            old_path,
            status: status.to_string(),
            staged,
            unstaged,
            conflict,
        });
    }
    (current_branch, detached, changes)
}

fn unquote_path(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        trimmed.to_string()
    }
}

fn ahead_behind(root: &Path, upstream: Option<&str>) -> (u32, u32) {
    if upstream.is_none() {
        return (0, 0);
    }
    run_git_in(
        Some(root),
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .ok()
    .and_then(|raw| {
        let mut parts = raw.split_whitespace();
        let ahead = parts.next()?.parse().ok()?;
        let behind = parts.next()?.parse().ok()?;
        Some((ahead, behind))
    })
    .unwrap_or((0, 0))
}

fn list_remote_names(root: &Path) -> Result<Vec<String>, String> {
    Ok(run_git_in(Some(root), ["remote"])?
        .lines()
        .filter_map(non_empty_string)
        .collect())
}

fn list_remotes(root: &Path) -> Result<Vec<GitRemote>, String> {
    let mut remotes = Vec::new();
    for name in list_remote_names(root)? {
        let fetch_url = run_git_in(Some(root), ["remote", "get-url", name.as_str()])?;
        let push_url = run_git_in(Some(root), ["remote", "get-url", "--push", name.as_str()])
            .ok()
            .and_then(|s| non_empty_string(&s))
            .filter(|url| url != fetch_url.trim());
        remotes.push(GitRemote {
            username: get_config(root, &remote_auth_key(&name, "username")),
            token_ref: get_config(root, &remote_auth_key(&name, "tokenRef")),
            name,
            fetch_url: fetch_url.trim().to_string(),
            push_url,
        });
    }
    Ok(remotes)
}

fn remote_auth_key(remote: &str, leaf: &str) -> String {
    let safe_remote: String = remote
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    format!("{AUTH_SECTION}.{safe_remote}.{leaf}")
}

fn load_settings(root: &Path) -> GitRepoSettings {
    GitRepoSettings {
        user_name: get_config(root, "user.name"),
        user_email: get_config(root, "user.email"),
        http_proxy: get_config(root, "http.proxy"),
        https_proxy: get_config(root, "https.proxy"),
        pull_rebase: get_config(root, "pull.rebase"),
        push_default: get_config(root, "push.default"),
        core_autocrlf: get_config(root, "core.autocrlf"),
        core_filemode: get_config(root, "core.filemode"),
        commit_gpgsign: get_config(root, "commit.gpgsign"),
    }
}

fn get_config(root: &Path, key: &str) -> Option<String> {
    run_git_in(Some(root), ["config", "--local", "--get", key])
        .ok()
        .and_then(|value| non_empty_string(&value))
}

fn set_optional_config(root: &Path, key: &str, value: Option<String>) -> Result<(), String> {
    match value.and_then(|s| non_empty_string(&s)) {
        Some(value) => {
            run_git_in(Some(root), ["config", "--local", key, value.as_str()]).map(|_| ())
        }
        None => unset_config(root, key),
    }
}

fn unset_config(root: &Path, key: &str) -> Result<(), String> {
    let _ = run_git_in(Some(root), ["config", "--local", "--unset", key]);
    Ok(())
}

fn list_branches(root: &Path) -> Result<Vec<GitBranch>, String> {
    let raw = run_git_in(
        Some(root),
        [
            "for-each-ref",
            "refs/heads",
            "refs/remotes",
            "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(HEAD)%1f%(objectname:short)%1f%(subject)",
        ],
    )?;
    let mut branches = Vec::new();
    for line in raw.lines() {
        let parts: Vec<_> = line.split('\x1f').collect();
        if parts.len() < 6 {
            continue;
        }
        let full_name = parts[0].to_string();
        if full_name.ends_with("/HEAD") {
            continue;
        }
        branches.push(GitBranch {
            name: parts[1].to_string(),
            full_name: full_name.clone(),
            current: parts[3] == "*",
            remote: full_name.starts_with("refs/remotes/"),
            upstream: non_empty_string(parts[2]),
            oid: non_empty_string(parts[4]),
            subject: non_empty_string(parts[5]),
        });
    }
    Ok(branches)
}

fn list_log(root: &Path, filter: &GitLogFilter) -> Result<Vec<GitLogEntry>, String> {
    let limit = filter.limit.unwrap_or(120).clamp(1, 2000).to_string();
    let mut args: Vec<String> = vec![
        "log".into(),
        "--date=iso-strict".into(),
        "--pretty=format:%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%b".into(),
        "-n".into(),
        limit,
    ];
    if let Some(skip) = filter.skip.filter(|n| *n > 0) {
        args.push("--skip".into());
        args.push(skip.to_string());
    }
    if let Some(author) = filter.author.as_deref().and_then(non_empty_string) {
        args.push("--author".into());
        args.push(author);
    }
    if let Some(grep) = filter.grep.as_deref().and_then(non_empty_string) {
        args.push("-i".into());
        args.push("--grep".into());
        args.push(grep);
    }
    if let Some(after) = filter.after.as_deref().and_then(non_empty_string) {
        args.push("--after".into());
        args.push(after);
    }
    if let Some(before) = filter.before.as_deref().and_then(non_empty_string) {
        args.push("--before".into());
        args.push(before);
    }
    if let Some(branch) = filter.branch.as_deref().and_then(non_empty_string) {
        args.push(branch);
    } else if filter.all.unwrap_or(false) {
        args.push("--all".into());
    }
    if let Some(path) = filter.path.as_deref().and_then(non_empty_string) {
        args.push("--".into());
        args.push(path);
    }
    let raw = run_git_strings(Some(root), args)?;
    Ok(parse_log_entries(&raw))
}

fn parse_log_entries(raw: &str) -> Vec<GitLogEntry> {
    let mut entries = Vec::new();
    for record in raw.split('\x1e') {
        let record = record.trim_start_matches('\n').trim_end_matches('\n');
        if record.is_empty() {
            continue;
        }
        let parts: Vec<_> = record.splitn(9, '\x1f').collect();
        if parts.len() < 7 {
            continue;
        }
        entries.push(GitLogEntry {
            oid: parts[0].to_string(),
            short_oid: parts[1].to_string(),
            parents: parts[2]
                .split_whitespace()
                .filter_map(non_empty_string)
                .collect(),
            author_name: parts[3].to_string(),
            author_email: parts[4].to_string(),
            date: parts[5].to_string(),
            subject: parts[6].to_string(),
            refs: parts.get(7).map(|d| parse_refs(d)).unwrap_or_default(),
            body: parts.get(8).map(|d| trim_log_body(d)).unwrap_or_default(),
        });
    }
    entries
}

fn trim_log_body(body: &str) -> String {
    body.trim_matches(|c| c == '\n' || c == '\r').to_string()
}

/// Parse a `%D` decoration string ("HEAD -> main, origin/main, tag: v1") into
/// short ref labels for chips.
fn parse_refs(decoration: &str) -> Vec<String> {
    decoration
        .split(", ")
        .filter_map(|token| {
            let token = token.trim();
            let cleaned = token
                .strip_prefix("HEAD -> ")
                .or_else(|| token.strip_prefix("tag: "))
                .unwrap_or(token);
            non_empty_string(cleaned)
        })
        .filter(|t| t != "HEAD")
        .collect()
}

fn parse_name_status(output: &str) -> Vec<GitChange> {
    let mut out = Vec::new();
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let code = parts.next().unwrap_or("");
        let c0 = code.chars().next().unwrap_or(' ');
        let (old_path, path) = match c0 {
            'R' | 'C' => {
                let old = parts.next().map(unquote_path);
                let new = parts.next().map(unquote_path).or_else(|| old.clone());
                (old, new.unwrap_or_default())
            }
            _ => (None, parts.next().map(unquote_path).unwrap_or_default()),
        };
        let status = match c0 {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "copied",
            _ => "modified",
        };
        out.push(GitChange {
            path,
            old_path,
            status: status.to_string(),
            staged: false,
            unstaged: false,
            conflict: false,
        });
    }
    out
}

fn parse_blame_porcelain(output: &str) -> Vec<GitBlameLine> {
    #[derive(Default)]
    struct PendingLine {
        commit: String,
        line: Option<u32>,
        author: String,
        author_mail: Option<String>,
        author_time: i64,
        summary: String,
    }

    let mut pending = PendingLine::default();
    let mut result = Vec::new();
    for line in output.lines() {
        if line.starts_with('\t') {
            if let Some(line_number) = pending.line.take() {
                result.push(GitBlameLine {
                    line: line_number,
                    commit: std::mem::take(&mut pending.commit),
                    author: std::mem::take(&mut pending.author),
                    author_mail: pending.author_mail.take(),
                    author_time: pending.author_time,
                    summary: std::mem::take(&mut pending.summary),
                });
            }
            pending = PendingLine::default();
            continue;
        }

        let mut header = line.split_whitespace();
        let maybe_commit = header.next().unwrap_or_default();
        let maybe_original = header.next().and_then(|value| value.parse::<u32>().ok());
        let maybe_final = header.next().and_then(|value| value.parse::<u32>().ok());
        if maybe_commit.len() >= 8 && maybe_original.is_some() && maybe_final.is_some() {
            pending.commit = maybe_commit.to_string();
            pending.line = maybe_final;
            continue;
        }
        if let Some(value) = line.strip_prefix("author ") {
            pending.author = value.to_string();
        } else if let Some(value) = line.strip_prefix("author-mail ") {
            pending.author_mail = non_empty_string(value.trim_matches(['<', '>']));
        } else if let Some(value) = line.strip_prefix("author-time ") {
            pending.author_time = value.parse().unwrap_or_default();
        } else if let Some(value) = line.strip_prefix("summary ") {
            pending.summary = value.to_string();
        }
    }
    result
}

fn list_tags(root: &Path) -> Result<Vec<GitTag>, String> {
    let raw = run_git_in(
        Some(root),
        [
            "for-each-ref",
            "refs/tags",
            "--sort=-creatordate",
            "--format=%(refname:short)%1f%(objectname:short)%1f%(objecttype)%1f%(contents:subject)",
        ],
    )?;
    let mut tags = Vec::new();
    for line in raw.lines() {
        let parts: Vec<_> = line.split('\x1f').collect();
        if parts.len() < 4 {
            continue;
        }
        tags.push(GitTag {
            name: parts[0].to_string(),
            oid: parts[1].to_string(),
            annotated: parts[2] == "tag",
            subject: non_empty_string(parts[3]),
        });
    }
    Ok(tags)
}

fn list_stashes(root: &Path) -> Result<Vec<GitStashEntry>, String> {
    let raw = run_git_in(
        Some(root),
        [
            "stash",
            "list",
            "--date=iso-strict",
            "--pretty=format:%gd%x1f%H%x1f%cr%x1f%gs",
        ],
    )?;
    let mut stashes = Vec::new();
    for line in raw.lines() {
        let parts: Vec<_> = line.split('\x1f').collect();
        if parts.len() < 4 {
            continue;
        }
        stashes.push(GitStashEntry {
            selector: parts[0].to_string(),
            oid: parts[1].to_string(),
            date: parts[2].to_string(),
            message: parts[3].to_string(),
        });
    }
    Ok(stashes)
}

fn run_git_in<'a, I>(cwd: Option<&Path>, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = &'a str>,
{
    let args = args.into_iter().map(|s| s.to_string()).collect();
    run_git_strings(cwd, args)
}

fn run_git_strings(cwd: Option<&Path>, args: Vec<String>) -> Result<String, String> {
    let mut command = new_git_command();
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    apply_stable_locale(&mut command);
    for arg in args {
        command.arg(arg);
    }
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    command_output(output)
}

/// Force git to emit machine-stable English output. Porcelain strings such as
/// "No commits yet on", "[ahead N]" and rename markers are localized otherwise,
/// which breaks status/branch parsing for users on non-English git locales.
fn apply_stable_locale(command: &mut Command) {
    command.env("LC_ALL", "C");
    command.env("LANG", "C");
}

fn run_git_authed(
    root: &Path,
    args: Vec<String>,
    vault: Arc<Vault>,
    remote: Option<&str>,
) -> Result<String, String> {
    let remote = remote
        .and_then(non_empty_string)
        .or_else(|| default_remote_for_head(root))
        .or_else(|| {
            list_remote_names(root)
                .ok()
                .and_then(|items| items.into_iter().next())
        });
    let auth = remote
        .as_deref()
        .and_then(|remote| load_remote_auth(root, remote, &vault).transpose())
        .transpose()?;
    let Some((username, token)) = auth else {
        return run_git_strings(Some(root), args);
    };
    let askpass = write_askpass_script()?;
    let mut command = new_git_command();
    command.current_dir(root);
    apply_stable_locale(&mut command);
    for arg in args {
        command.arg(arg);
    }
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_ASKPASS", askpass.as_os_str());
    command.env("TAOMNI_GIT_USERNAME", username);
    command.env("TAOMNI_GIT_PASSWORD", token.as_str());
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"));
    let _ = fs::remove_file(&askpass);
    command_output(output?)
}

fn default_remote_for_head(root: &Path) -> Option<String> {
    current_branch_name(root)
        .as_deref()
        .and_then(|branch| get_config(root, &format!("branch.{branch}.remote")))
        .or_else(|| {
            run_git_in(
                Some(root),
                ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            )
            .ok()
            .and_then(|upstream| upstream.split('/').next().and_then(non_empty_string))
        })
}

fn build_pull_args(
    root: &Path,
    remote: Option<&str>,
    branch: Option<&str>,
    rebase: bool,
) -> Result<Vec<String>, String> {
    let mut args = vec!["pull".to_string()];
    if rebase {
        args.push("--rebase".into());
    }
    let Some(remote) = remote.and_then(non_empty_string) else {
        return Ok(args);
    };
    args.push(remote.clone());
    let branch = branch
        .and_then(non_empty_string)
        .or_else(|| upstream_branch_for_remote(root, &remote))
        .or_else(|| current_branch_name(root));
    let Some(branch) = branch else {
        return Err(
            "Pull from a selected remote requires a branch, but the current HEAD is detached."
                .into(),
        );
    };
    args.push(branch);
    Ok(args)
}

fn current_branch_name(root: &Path) -> Option<String> {
    run_git_in(Some(root), ["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .and_then(|s| non_empty_string(&s))
}

fn upstream_branch_for_remote(root: &Path, remote: &str) -> Option<String> {
    let branch = current_branch_name(root)?;
    let configured_remote = get_config(root, &format!("branch.{branch}.remote"))?;
    if configured_remote.trim() != remote {
        return None;
    }
    let merge = get_config(root, &format!("branch.{branch}.merge"))?;
    let remote_branch = merge
        .trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(merge.trim());
    non_empty_string(remote_branch)
}

fn load_remote_auth(
    root: &Path,
    remote: &str,
    vault: &Vault,
) -> Result<Option<(String, zeroize::Zeroizing<String>)>, String> {
    let Some(token_ref) = get_config(root, &remote_auth_key(remote, "tokenRef")) else {
        return Ok(None);
    };
    let token = vault
        .resolve(&token_ref)?
        .ok_or_else(|| "git token setting is not a vault reference".to_string())?;
    let username = get_config(root, &remote_auth_key(remote, "username"))
        .unwrap_or_else(|| "x-access-token".to_string());
    Ok(Some((username, token)))
}

fn command_output(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        Err(if detail.is_empty() {
            format!("git exited with {}", output.status)
        } else {
            detail
        })
    }
}

fn write_askpass_script() -> Result<PathBuf, String> {
    let suffix = if cfg!(windows) { "cmd" } else { "sh" };
    let path = std::env::temp_dir().join(format!(
        "taomni-git-askpass-{}.{}",
        uuid::Uuid::new_v4(),
        suffix
    ));
    let content = if cfg!(windows) {
        "@echo off\r\necho %1 | findstr /I \"Username\" >nul\r\nif errorlevel 1 (echo %TAOMNI_GIT_PASSWORD%) else (echo %TAOMNI_GIT_USERNAME%)\r\n"
    } else {
        "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$TAOMNI_GIT_USERNAME\" ;;\n  *) printf '%s\\n' \"$TAOMNI_GIT_PASSWORD\" ;;\nesac\n"
    };
    fs::write(&path, content).map_err(|e| format!("failed to write askpass script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o700);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }
    Ok(path)
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

const MAX_DIFF_BYTES: usize = 2_000_000;
const MAX_DIFF_BYTES_U64: u64 = MAX_DIFF_BYTES as u64;

#[derive(Debug, Clone)]
struct BlobSide {
    exists: bool,
    bytes: Option<Vec<u8>>,
    size: u64,
}

impl BlobSide {
    fn absent() -> Self {
        Self {
            exists: false,
            bytes: None,
            size: 0,
        }
    }

    fn from_bytes(bytes: Vec<u8>) -> Self {
        Self {
            size: bytes.len() as u64,
            exists: true,
            bytes: Some(bytes),
        }
    }

    fn oversized(size: u64) -> Self {
        Self {
            exists: true,
            bytes: None,
            size,
        }
    }
}

fn read_blob(root: &Path, reference: &str, path: &str) -> Result<BlobSide, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Ok(BlobSide::absent());
    }
    if reference == ":WORKTREE" {
        let full = root.join(path);
        let size = match fs::metadata(&full) {
            Ok(metadata) => metadata.len(),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BlobSide::absent());
            }
            Err(e) => return Err(format!("failed to stat {path}: {e}")),
        };
        if size > MAX_DIFF_BYTES_U64 {
            return Ok(BlobSide::oversized(size));
        }
        return match fs::read(&full) {
            Ok(bytes) => Ok(BlobSide::from_bytes(bytes)),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BlobSide::absent()),
            Err(e) => Err(format!("failed to read {path}: {e}")),
        };
    }
    let spec = if reference == ":INDEX" {
        format!(":{path}")
    } else {
        format!("{reference}:{path}")
    };
    let size = match git_blob_size(root, &spec)? {
        Some(size) => size,
        None => return Ok(BlobSide::absent()),
    };
    if size > MAX_DIFF_BYTES_U64 {
        return Ok(BlobSide::oversized(size));
    }
    let output = new_git_command()
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .args(["show", spec.as_str()])
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    // A path that does not exist at the requested ref is "absent" rather than an
    // error: that is the added/deleted side of a diff.
    if output.status.success() {
        Ok(BlobSide::from_bytes(output.stdout))
    } else {
        Ok(BlobSide::absent())
    }
}

fn git_blob_size(root: &Path, spec: &str) -> Result<Option<u64>, String> {
    let output = new_git_command()
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .args(["cat-file", "-s", spec])
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    raw.trim()
        .parse::<u64>()
        .map(Some)
        .map_err(|e| format!("failed to parse blob size for {spec}: {e}"))
}

fn build_blob_pair(
    path: String,
    old_path: Option<String>,
    old_blob: BlobSide,
    new_blob: BlobSide,
) -> GitBlobPair {
    let old_exists = old_blob.exists;
    let new_exists = new_blob.exists;
    let old_size = old_blob.size;
    let new_size = new_blob.size;
    let old_bytes = old_blob.bytes;
    let new_bytes = new_blob.bytes;
    let image = is_image_path(&path);
    let oversize = old_size > MAX_DIFF_BYTES_U64 || new_size > MAX_DIFF_BYTES_U64;

    if image && !oversize {
        return GitBlobPair {
            path,
            old_path,
            old_text: None,
            new_text: None,
            old_exists,
            new_exists,
            binary: true,
            image: true,
            old_image_b64: old_bytes.as_deref().map(|b| B64.encode(b)),
            new_image_b64: new_bytes.as_deref().map(|b| B64.encode(b)),
            oversize: false,
            old_size,
            new_size,
        };
    }

    let binary = is_binary(old_bytes.as_deref()) || is_binary(new_bytes.as_deref());
    let (old_text, new_text) = if binary || oversize {
        (None, None)
    } else {
        (
            old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
            new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
        )
    };
    GitBlobPair {
        path,
        old_path,
        old_text,
        new_text,
        old_exists,
        new_exists,
        binary,
        image: false,
        old_image_b64: None,
        new_image_b64: None,
        oversize,
        old_size,
        new_size,
    }
}

fn is_binary(bytes: Option<&[u8]>) -> bool {
    match bytes {
        Some(b) => b.iter().take(8000).any(|&c| c == 0),
        None => false,
    }
}

fn is_image_path(path: &str) -> bool {
    let ext = path.rsplit('.').next().map(|e| e.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tiff" | "avif")
    )
}

fn git_path(root: &Path, name: &str) -> Option<PathBuf> {
    run_git_in(Some(root), ["rev-parse", "--git-path", name])
        .ok()
        .and_then(|s| non_empty_string(&s))
        .map(|p| {
            let pb = PathBuf::from(&p);
            if pb.is_absolute() { pb } else { root.join(pb) }
        })
}

/// Detect an in-progress operation that may be holding a conflict, so the UI can
/// label continue/abort correctly (a long-standing bug: it always said "cherry-pick").
fn detect_operation(root: &Path) -> String {
    let exists = |name: &str| git_path(root, name).map(|p| p.exists()).unwrap_or(false);
    if exists("rebase-merge") || exists("rebase-apply") {
        "rebase".into()
    } else if exists("MERGE_HEAD") {
        "merge".into()
    } else if exists("CHERRY_PICK_HEAD") {
        "cherryPick".into()
    } else if exists("REVERT_HEAD") {
        "revert".into()
    } else {
        "none".into()
    }
}

fn conflicted_paths(root: &Path) -> Vec<String> {
    run_git_in(Some(root), ["diff", "--name-only", "--diff-filter=U"])
        .ok()
        .map(|s| s.lines().filter_map(non_empty_string).collect())
        .unwrap_or_default()
}

fn operation_command(kind: &str) -> Result<&'static str, String> {
    match kind {
        "merge" => Ok("merge"),
        "cherryPick" | "cherry-pick" => Ok("cherry-pick"),
        "revert" => Ok("revert"),
        "rebase" => Ok("rebase"),
        other => Err(format!("unknown git operation: {other}")),
    }
}

fn run_git_no_editor(root: &Path, args: Vec<String>) -> Result<String, String> {
    let mut command = new_git_command();
    command.current_dir(root);
    apply_stable_locale(&mut command);
    command.env("GIT_EDITOR", "true");
    command.env("GIT_TERMINAL_PROMPT", "0");
    for arg in args {
        command.arg(arg);
    }
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    command_output(output)
}

fn new_git_command() -> Command {
    let mut command = Command::new("git");
    no_console_window(&mut command);
    command
}

/// Release builds are Windows GUI-subsystem processes. Without this flag,
/// short-lived `git.exe` probes can flash console windows behind the app.
fn no_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

fn require_non_empty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(windows)]
    #[test]
    fn maps_windows_shell_paths_for_git_cwd() {
        assert_eq!(
            git_cwd_path("/D:/code/person/taomni"),
            PathBuf::from(r"D:\code\person\taomni")
        );
        assert_eq!(
            git_cwd_path("/d/code/person/taomni"),
            PathBuf::from(r"D:\code\person\taomni")
        );
        assert_eq!(git_cwd_path("/c"), PathBuf::from(r"C:\"));
        assert_eq!(git_cwd_path("/C:"), PathBuf::from(r"C:\"));
        assert_eq!(
            git_cwd_path("/cygdrive/e/work/repo"),
            PathBuf::from(r"E:\work\repo")
        );
        assert_eq!(
            git_cwd_path("/home/user/repo"),
            PathBuf::from("/home/user/repo")
        );
    }

    #[cfg(windows)]
    #[test]
    fn probes_repo_from_msys_drive_path() {
        if !git_available() {
            return;
        }

        let tmp = TempDir::new().unwrap();
        run_git_in(Some(tmp.path()), ["init"]).unwrap();

        let native = tmp.path().to_string_lossy();
        let bytes = native.as_bytes();
        if bytes.len() < 3 || bytes[1] != b':' {
            return;
        }
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = native[2..].replace('\\', "/");
        let msys_path = format!("/{drive}/{}", rest.trim_start_matches('/'));

        let probe = probe_path(&msys_path).unwrap();
        assert!(probe.is_repo, "{probe:?}");
        assert!(probe.repo_root.is_some(), "{probe:?}");
    }

    #[test]
    fn normalizes_and_escapes_literal_gitignore_targets() {
        assert_eq!(
            normalize_git_ignore_target("./build/output.log").unwrap(),
            "build/output.log"
        );
        assert!(normalize_git_ignore_target("../secret").is_err());
        assert!(normalize_git_ignore_target("build//output").is_err());
        assert_eq!(
            escape_git_ignore_literal("build output/[draft]#1?.log"),
            "build\\ output/\\[draft\\]\\#1\\?.log"
        );
    }

    #[test]
    fn adds_gitignore_rules_idempotently_and_rejects_tracked_files() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        fs::write(root.join("scratch.log"), "scratch").unwrap();

        let added = add_git_ignore_rule(root, "scratch.log", false).unwrap();
        assert!(added.added);
        assert_eq!(added.rule, "/scratch.log");
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "/scratch.log\n"
        );

        let duplicate = add_git_ignore_rule(root, "scratch.log", false).unwrap();
        assert!(!duplicate.added);
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "/scratch.log\n"
        );

        fs::write(root.join("tracked.txt"), "tracked").unwrap();
        run_git_in(Some(root), ["add", "tracked.txt"]).unwrap();
        let error = add_git_ignore_rule(root, "tracked.txt", false).unwrap_err();
        assert!(error.contains("Tracked path cannot be ignored"), "{error}");
    }

    #[test]
    fn parses_status_with_branch_and_changes() {
        let raw = "## main...origin/main [ahead 1]\n M src/a.ts\nA  src/b.ts\n?? notes.txt\nUU conflicted.txt\nR  old.txt -> new.txt\n";
        let (branch, detached, changes) = parse_status(raw);
        assert_eq!(branch.as_deref(), Some("main"));
        assert!(!detached);
        assert_eq!(changes.len(), 5);
        assert_eq!(changes[0].status, "modified");
        assert_eq!(changes[1].status, "added");
        assert_eq!(changes[2].status, "untracked");
        assert_eq!(changes[3].status, "conflicted");
        assert_eq!(changes[4].old_path.as_deref(), Some("old.txt"));
        assert_eq!(changes[4].path, "new.txt");
    }

    #[test]
    fn parses_unborn_branch_status() {
        let (branch, detached, changes) = parse_status("## No commits yet on main\n?? file.txt\n");
        assert_eq!(branch.as_deref(), Some("main"));
        assert!(!detached);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].status, "untracked");
    }

    #[test]
    fn remote_auth_key_sanitizes_remote_names() {
        assert_eq!(
            remote_auth_key("origin/private", "tokenRef"),
            "taomni-auth.origin-private.tokenRef"
        );
    }

    #[test]
    fn pull_args_add_current_branch_for_selected_remote() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();

        let args = build_pull_args(root, Some("origin"), None, false).unwrap();
        assert_eq!(args, vec!["pull", "origin", "main"]);
    }

    #[test]
    fn pull_args_prefer_upstream_branch_for_selected_remote() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        run_git_in(Some(root), ["checkout", "-b", "feature/local"]).unwrap();
        run_git_in(
            Some(root),
            ["config", "branch.feature/local.remote", "origin"],
        )
        .unwrap();
        run_git_in(
            Some(root),
            ["config", "branch.feature/local.merge", "refs/heads/main"],
        )
        .unwrap();

        let args = build_pull_args(root, Some("origin"), None, true).unwrap();
        assert_eq!(args, vec!["pull", "--rebase", "origin", "main"]);
    }

    #[test]
    fn snapshots_real_repo_status_and_log() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
        run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
        run_git_in(Some(root), ["config", "user.email", "taomni@example.test"]).unwrap();

        fs::write(root.join("readme.md"), "hello\n").unwrap();
        let initial = snapshot(root).unwrap();
        assert_eq!(initial.current_branch.as_deref(), Some("main"));
        assert_eq!(initial.changes.len(), 1);
        assert_eq!(initial.changes[0].status, "untracked");

        run_git_in(Some(root), ["add", "readme.md"]).unwrap();
        let staged = snapshot(root).unwrap();
        assert!(staged.changes[0].staged);

        run_git_in(Some(root), ["commit", "-m", "initial commit"]).unwrap();
        let clean = snapshot(root).unwrap();
        assert!(clean.changes.is_empty());
        let log = list_log(
            root,
            &GitLogFilter {
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(log[0].subject, "initial commit");

        fs::write(root.join("readme.md"), "hello\nworld\n").unwrap();
        let modified = snapshot(root).unwrap();
        assert_eq!(modified.changes.len(), 1);
        assert_eq!(modified.changes[0].status, "modified");
        assert!(modified.changes[0].unstaged);
    }

    #[test]
    fn reads_real_repo_remotes_and_local_settings() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        run_git_in(
            Some(root),
            ["remote", "add", "origin", "https://example.test/repo.git"],
        )
        .unwrap();
        set_optional_config(root, "user.name", Some("Repo User".to_string())).unwrap();
        set_optional_config(root, "user.email", Some("repo@example.test".to_string())).unwrap();
        set_optional_config(
            root,
            "http.proxy",
            Some("http://127.0.0.1:8080".to_string()),
        )
        .unwrap();
        set_optional_config(
            root,
            &remote_auth_key("origin", "username"),
            Some("octo".to_string()),
        )
        .unwrap();
        set_optional_config(
            root,
            &remote_auth_key("origin", "tokenRef"),
            Some("vault:test-token".to_string()),
        )
        .unwrap();

        let remotes = list_remotes(root).unwrap();
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].fetch_url, "https://example.test/repo.git");
        assert_eq!(remotes[0].username.as_deref(), Some("octo"));
        assert_eq!(remotes[0].token_ref.as_deref(), Some("vault:test-token"));

        let settings = load_settings(root);
        assert_eq!(settings.user_name.as_deref(), Some("Repo User"));
        assert_eq!(settings.user_email.as_deref(), Some("repo@example.test"));
        assert_eq!(
            settings.http_proxy.as_deref(),
            Some("http://127.0.0.1:8080")
        );
    }

    #[test]
    fn detects_image_and_binary_content() {
        assert!(is_image_path("assets/logo.PNG"));
        assert!(is_image_path("a/b/c.jpeg"));
        assert!(!is_image_path("diagram.drawio"));
        assert!(!is_image_path("src/main.rs"));
        assert!(is_binary(Some(&[0x00, 0x01, 0x02])));
        assert!(!is_binary(Some(b"plain text\n")));
        assert!(!is_binary(None));
    }

    #[test]
    fn blob_pair_handles_untracked_added_side() {
        // No old side (empty ref) + new working-tree side => added file shown in full.
        let pair = build_blob_pair(
            "notes.txt".into(),
            None,
            BlobSide::absent(),
            BlobSide::from_bytes(b"line one\nline two\n".to_vec()),
        );
        assert!(!pair.old_exists);
        assert!(pair.new_exists);
        assert!(!pair.binary);
        assert_eq!(pair.old_text, None);
        assert_eq!(pair.new_text.as_deref(), Some("line one\nline two\n"));
    }

    #[test]
    fn blob_pair_marks_images_with_base64() {
        let pair = build_blob_pair(
            "logo.png".into(),
            None,
            BlobSide::absent(),
            BlobSide::from_bytes(vec![0x89, 0x50, 0x4e, 0x47]),
        );
        assert!(pair.image);
        assert!(pair.binary);
        assert_eq!(pair.new_text, None);
        assert_eq!(pair.new_image_b64.as_deref(), Some("iVBORw=="));
    }

    #[test]
    fn reads_worktree_and_head_blobs() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
        run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
        run_git_in(Some(root), ["config", "user.email", "t@example.test"]).unwrap();
        fs::write(root.join("a.txt"), "v1\n").unwrap();
        run_git_in(Some(root), ["add", "a.txt"]).unwrap();
        run_git_in(Some(root), ["commit", "-m", "init"]).unwrap();
        fs::write(root.join("a.txt"), "v2\n").unwrap();

        let head = read_blob(root, "HEAD", "a.txt").unwrap();
        assert!(head.exists);
        assert_eq!(head.bytes.as_deref(), Some(b"v1\n".as_ref()));
        let worktree = read_blob(root, ":WORKTREE", "a.txt").unwrap();
        assert!(worktree.exists);
        assert_eq!(worktree.bytes.as_deref(), Some(b"v2\n".as_ref()));
        // Missing path at a ref is absent, not an error.
        assert!(!read_blob(root, "HEAD", "missing.txt").unwrap().exists);
        assert!(!read_blob(root, "", "a.txt").unwrap().exists);
    }

    #[test]
    fn skips_oversized_worktree_blob_body() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let path = root.join("large.txt");
        fs::write(&path, vec![b'a'; MAX_DIFF_BYTES + 1]).unwrap();

        let blob = read_blob(root, ":WORKTREE", "large.txt").unwrap();
        assert!(blob.exists);
        assert_eq!(blob.size, (MAX_DIFF_BYTES + 1) as u64);
        assert!(blob.bytes.is_none());

        let pair = build_blob_pair("large.txt".into(), None, BlobSide::absent(), blob);
        assert!(pair.oversize);
        assert!(pair.new_exists);
        assert_eq!(pair.new_size, (MAX_DIFF_BYTES + 1) as u64);
        assert_eq!(pair.new_text, None);
    }

    #[test]
    fn selective_commit_only_includes_chosen_paths() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
        run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
        run_git_in(Some(root), ["config", "user.email", "t@example.test"]).unwrap();
        fs::write(root.join("seed.txt"), "seed\n").unwrap();
        run_git_in(Some(root), ["add", "seed.txt"]).unwrap();
        run_git_in(Some(root), ["commit", "-m", "seed"]).unwrap();

        // One untracked file we want, one staged file we do NOT want in this commit.
        fs::write(root.join("wanted.txt"), "wanted\n").unwrap();
        fs::write(root.join("other.txt"), "other\n").unwrap();
        run_git_in(Some(root), ["add", "other.txt"]).unwrap();

        commit_changes(
            root,
            "add wanted only",
            false,
            Some(vec!["wanted.txt".into()]),
        )
        .unwrap();

        // wanted.txt is committed; other.txt remains staged (uncommitted).
        let committed =
            run_git_in(Some(root), ["show", "--name-only", "--format=", "HEAD"]).unwrap();
        assert!(committed.contains("wanted.txt"));
        assert!(!committed.contains("other.txt"));
        let snap = snapshot(root).unwrap();
        let other = snap.changes.iter().find(|c| c.path == "other.txt").unwrap();
        assert!(other.staged);
    }

    #[test]
    fn detects_merge_conflict_operation() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
        run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
        run_git_in(Some(root), ["config", "user.email", "t@example.test"]).unwrap();
        fs::write(root.join("f.txt"), "base\n").unwrap();
        run_git_in(Some(root), ["add", "f.txt"]).unwrap();
        run_git_in(Some(root), ["commit", "-m", "base"]).unwrap();
        assert_eq!(detect_operation(root), "none");

        run_git_in(Some(root), ["checkout", "-b", "feature"]).unwrap();
        fs::write(root.join("f.txt"), "feature\n").unwrap();
        run_git_in(Some(root), ["commit", "-am", "feature"]).unwrap();
        run_git_in(Some(root), ["checkout", "main"]).unwrap();
        fs::write(root.join("f.txt"), "mainline\n").unwrap();
        run_git_in(Some(root), ["commit", "-am", "mainline"]).unwrap();

        // Conflicting merge leaves MERGE_HEAD + an unmerged path.
        let _ = run_git_in(Some(root), ["merge", "feature"]);
        assert_eq!(detect_operation(root), "merge");
        assert_eq!(conflicted_paths(root), vec!["f.txt".to_string()]);
        assert_eq!(operation_command("merge").unwrap(), "merge");
        assert!(operation_command("bogus").is_err());
    }

    #[test]
    fn parses_decoration_refs() {
        assert_eq!(
            parse_refs("HEAD -> main, origin/main, tag: v1.0"),
            vec![
                "main".to_string(),
                "origin/main".to_string(),
                "v1.0".to_string()
            ]
        );
        assert!(parse_refs("").is_empty());
    }

    #[test]
    fn parses_log_entries_with_multiline_body() {
        let raw = concat!(
            "\x1eabcdef0123456789\x1fabcdef0\x1f1234567 7654321\x1fAda\x1fada@example.test\x1f",
            "2026-07-04T10:00:00Z\x1ffeat: show commit message\x1fHEAD -> main, tag: v1.0\x1f",
            "Body line one\n\nBody line two\n",
            "\x1e1234567890abcdef\x1f1234567\x1f\x1fBen\x1fben@example.test\x1f",
            "2026-07-04T11:00:00Z\x1ffix: compact row\x1f\x1f",
        );

        let entries = parse_log_entries(raw);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "feat: show commit message");
        assert_eq!(entries[0].body, "Body line one\n\nBody line two");
        assert_eq!(
            entries[0].refs,
            vec!["main".to_string(), "v1.0".to_string()]
        );
        assert_eq!(
            entries[0].parents,
            vec!["1234567".to_string(), "7654321".to_string()]
        );
        assert_eq!(entries[1].subject, "fix: compact row");
        assert!(entries[1].body.is_empty());
    }

    #[test]
    fn parses_name_status_with_renames() {
        let changes =
            parse_name_status("M\tsrc/a.ts\nA\tnew.txt\nD\tgone.txt\nR100\told.txt\tnew.txt\n");
        assert_eq!(changes.len(), 4);
        assert_eq!(changes[0].status, "modified");
        assert_eq!(changes[1].status, "added");
        assert_eq!(changes[2].status, "deleted");
        assert_eq!(changes[3].status, "renamed");
        assert_eq!(changes[3].old_path.as_deref(), Some("old.txt"));
        assert_eq!(changes[3].path, "new.txt");
    }

    #[test]
    fn parses_line_porcelain_blame() {
        let raw = concat!(
            "0123456789abcdef0123456789abcdef01234567 3 7 1\n",
            "author Ada Lovelace\n",
            "author-mail <ada@example.test>\n",
            "author-time 1783814400\n",
            "author-tz +0800\n",
            "summary feat: add outline\n",
            "filename src/main.ts\n",
            "\tconst value = 1;\n",
            "0000000000000000000000000000000000000000 4 8 1\n",
            "author Not Committed Yet\n",
            "author-mail <not.committed.yet>\n",
            "author-time 1783814500\n",
            "summary Version of src/main.ts from src/main.ts\n",
            "filename src/main.ts\n",
            "\tconst draft = 2;\n",
        );

        let lines = parse_blame_porcelain(raw);

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].line, 7);
        assert_eq!(lines[0].author, "Ada Lovelace");
        assert_eq!(lines[0].author_mail.as_deref(), Some("ada@example.test"));
        assert_eq!(lines[0].summary, "feat: add outline");
        assert_eq!(lines[1].line, 8);
        assert!(lines[1].commit.chars().all(|character| character == '0'));
    }

    #[test]
    fn lists_lightweight_and_annotated_tags() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git_in(Some(root), ["init"]).unwrap();
        run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
        run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
        run_git_in(Some(root), ["config", "user.email", "t@example.test"]).unwrap();
        fs::write(root.join("f.txt"), "x\n").unwrap();
        run_git_in(Some(root), ["add", "f.txt"]).unwrap();
        run_git_in(Some(root), ["commit", "-m", "c1"]).unwrap();
        run_git_in(Some(root), ["tag", "v1"]).unwrap();
        run_git_in(Some(root), ["tag", "-a", "v2", "-m", "release two"]).unwrap();

        let tags = list_tags(root).unwrap();
        let names: Vec<_> = tags.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"v1"));
        assert!(names.contains(&"v2"));
        let v2 = tags.iter().find(|t| t.name == "v2").unwrap();
        assert!(v2.annotated);
        assert_eq!(v2.subject.as_deref(), Some("release two"));
        let v1 = tags.iter().find(|t| t.name == "v1").unwrap();
        assert!(!v1.annotated);
    }
}
