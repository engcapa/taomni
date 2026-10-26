use super::*;

// Directory and project discovery must never run on the desktop UI thread.
// Keep each scan independent so a slow recursive index cannot hold up a listing.
#[tauri::command]
pub async fn workspace_list_dir(
    repo_root: String,
    path: Option<String>,
) -> Result<Vec<WorkspaceEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_repo_root(&repo_root)?;
        let target = resolve_existing_path(&root, path.as_deref().unwrap_or(""))?;
        let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
        if !meta.is_dir() {
            return Err(format!("Not a directory: {}", target.display()));
        }

        list_workspace_entries(&root, &target)
    })
    .await
    .map_err(|error| format!("workspace_list_dir: {error}"))?
}

#[tauri::command]
pub async fn workspace_compact_chain(
    repo_root: String,
    path: String,
    max_depth: Option<usize>,
) -> Result<WorkspaceCompactChain, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_repo_root(&repo_root)?;
        let mut current = resolve_existing_path(&root, &path)?;
        let limit = max_depth.unwrap_or(16).min(HARD_RECURSIVE_MAX_DEPTH);

        for _ in 0..limit {
            let entries = list_workspace_entries(&root, &current)?;
            if entries.len() != 1 || entries[0].file_type != "dir" {
                return Ok(WorkspaceCompactChain {
                    path: relative_path(&root, &current)?,
                    entries,
                });
            }
            current = resolve_existing_path(&root, &entries[0].path)?;
        }

        Ok(WorkspaceCompactChain {
            path: relative_path(&root, &current)?,
            entries: list_workspace_entries(&root, &current)?,
        })
    })
    .await
    .map_err(|error| format!("workspace_compact_chain: {error}"))?
}

#[tauri::command]
pub async fn workspace_list_files_recursive(
    repo_root: String,
    path: Option<String>,
    max_depth: Option<usize>,
    max_files: Option<usize>,
) -> Result<Vec<WorkspaceEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_repo_root(&repo_root)?;
        let start = resolve_existing_path(&root, path.as_deref().unwrap_or(""))?;
        let meta = fs::metadata(&start).map_err(|e| format!("stat {}: {e}", start.display()))?;
        if !meta.is_dir() {
            return Err(format!("Not a directory: {}", start.display()));
        }

        let max_depth = max_depth
            .unwrap_or(DEFAULT_RECURSIVE_MAX_DEPTH)
            .min(HARD_RECURSIVE_MAX_DEPTH);
        let max_files = max_files
            .unwrap_or(DEFAULT_RECURSIVE_MAX_FILES)
            .min(HARD_RECURSIVE_MAX_FILES);
        let mut files = Vec::new();
        collect_workspace_files(&root, &start, 0, max_depth, max_files, &mut files)?;
        files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        Ok(files)
    })
    .await
    .map_err(|error| format!("workspace_list_files_recursive: {error}"))?
}

#[tauri::command]
pub async fn workspace_detect_git_roots(
    roots: Vec<WorkspaceGitRootCandidate>,
) -> Result<Vec<WorkspaceGitRoot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut repos: Vec<WorkspaceGitRoot> = Vec::new();
        for root in roots {
            let Ok(path) = fs::canonicalize(&root.path) else {
                continue;
            };
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            let mut found = Vec::new();
            if let Some(repo_root) = find_git_repo_root(&path) {
                found.push(repo_root);
            }
            let mut remaining_dirs = GIT_ROOT_SCAN_MAX_DIRS;
            collect_nested_git_roots(
                &path,
                0,
                GIT_ROOT_SCAN_MAX_DEPTH,
                &mut remaining_dirs,
                &mut found,
            )?;

            for repo_root in found {
                upsert_workspace_git_root(&mut repos, &root, &path, &repo_root);
            }
        }
        repos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(repos)
    })
    .await
    .map_err(|error| format!("workspace_detect_git_roots: {error}"))?
}
