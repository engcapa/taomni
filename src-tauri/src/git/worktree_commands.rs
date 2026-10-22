use super::*;

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
pub(super) fn commit_changes(
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
