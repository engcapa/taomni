use super::*;

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
