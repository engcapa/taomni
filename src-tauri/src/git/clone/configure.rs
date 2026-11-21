use super::*;

fn set_local_config(root: &Path, key: &str, value: &str) -> Result<(), String> {
    run_git_in(Some(root), ["config", "--local", key, value]).map(|_| ())
}

pub(super) fn apply_repo_config(
    request: &GitCloneRequest,
    destination: &Path,
    proxy: &(Option<String>, Option<String>),
    token: Option<&(String, Zeroizing<String>)>,
    remember_token: bool,
    vault: Option<&Vault>,
) -> Result<bool, String> {
    if let Some(name) = request
        .user_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_local_config(destination, "user.name", name)?;
    }
    if let Some(email) = request
        .user_email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_local_config(destination, "user.email", email)?;
    }
    // Explicit empty values make "No proxy" survive future fetch/pull/push even
    // when the process environment provides implicit proxies.
    set_local_config(destination, "http.proxy", proxy.0.as_deref().unwrap_or(""))?;
    set_local_config(destination, "https.proxy", proxy.1.as_deref().unwrap_or(""))?;

    let mut remembered = false;
    if let Some((username, token_value)) = token {
        let token_ref = if remember_token {
            let Some(vault) = vault else {
                return Err("Vault is unavailable; unlock it or clear Remember token".into());
            };
            vault.put_fixed(
                GIT_CLONE_TOKEN_ID,
                "git-token",
                "Git clone token",
                token_value.as_str(),
            )?;
            remembered = true;
            format!("vault:{GIT_CLONE_TOKEN_ID}")
        } else if request.use_saved_token {
            format!("vault:{GIT_CLONE_TOKEN_ID}")
        } else {
            String::new()
        };
        if !token_ref.is_empty() {
            set_optional_config(
                destination,
                &remote_auth_key("origin", "username"),
                Some(username.clone()),
            )?;
            set_optional_config(
                destination,
                &remote_auth_key("origin", "tokenRef"),
                Some(token_ref),
            )?;
        }
    }
    Ok(remembered)
}

pub(super) fn default_remote_branch(destination: &Path) -> Option<String> {
    run_git_in(
        Some(destination),
        [
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .ok()
    .and_then(|value| value.trim().strip_prefix("origin/").map(str::to_string))
    .and_then(|value| non_empty_string(&value))
}

pub(super) fn cleanup_failed_clone(destination: &Path, created: bool) -> Option<String> {
    if !created {
        return None;
    }
    match fs::remove_dir_all(destination) {
        Ok(()) => None,
        Err(error) => Some(format!(
            "Incomplete clone remains at {}: {error}",
            destination.display()
        )),
    }
}
