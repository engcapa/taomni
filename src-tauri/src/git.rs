use crate::state::AppState;
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::State;

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
pub struct GitRemoteAuthResult {
    pub username: Option<String>,
    pub token_ref: Option<String>,
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
        let path_buf = PathBuf::from(&path);
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
pub async fn git_commit(repo_root: String, message: String, amend: bool) -> Result<(), String> {
    blocking(move || {
        let root = PathBuf::from(repo_root);
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return Err("commit message is required".to_string());
        }
        let mut args = vec!["commit".to_string(), "-m".to_string(), trimmed.to_string()];
        if amend {
            args.push("--amend".into());
        }
        run_git_strings(Some(&root), args).map(|_| ())
    })
    .await
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
        let mut args = vec!["pull".to_string()];
        if rebase {
            args.push("--rebase".into());
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
pub async fn git_log(repo_root: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    blocking(move || list_log(&PathBuf::from(repo_root), limit.unwrap_or(120))).await
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
        settings: load_settings(root),
    })
}

fn probe_path(path: &str) -> Result<GitProbeResult, String> {
    let path_buf = PathBuf::from(path);
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

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn ensure_repo(root: &Path) -> Result<(), String> {
    run_git_in(Some(root), ["rev-parse", "--git-dir"]).map(|_| ())
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

fn list_log(root: &Path, limit: u32) -> Result<Vec<GitLogEntry>, String> {
    let limit = limit.clamp(1, 500).to_string();
    let raw = run_git_in(
        Some(root),
        [
            "log",
            "--date=iso-strict",
            "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s",
            "-n",
            limit.as_str(),
        ],
    )?;
    let mut entries = Vec::new();
    for line in raw.lines() {
        let parts: Vec<_> = line.split('\x1f').collect();
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
        });
    }
    Ok(entries)
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
    let mut command = Command::new("git");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for arg in args {
        command.arg(arg);
    }
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    command_output(output)
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
    let mut command = Command::new("git");
    command.current_dir(root);
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
    run_git_in(Some(root), ["config", "--get", "branch.HEAD.remote"])
        .ok()
        .and_then(|s| non_empty_string(&s))
        .or_else(|| {
            run_git_in(
                Some(root),
                ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            )
            .ok()
            .and_then(|upstream| upstream.split('/').next().and_then(non_empty_string))
        })
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
        let log = list_log(root, 10).unwrap();
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
}
