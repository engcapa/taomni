use super::*;

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
