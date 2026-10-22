use super::*;

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
