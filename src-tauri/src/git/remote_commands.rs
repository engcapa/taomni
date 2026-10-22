use super::*;

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
