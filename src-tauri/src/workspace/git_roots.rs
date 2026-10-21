use super::*;

pub(super) fn find_git_repo_root(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

pub(super) fn upsert_workspace_git_root(
    repos: &mut Vec<WorkspaceGitRoot>,
    workspace_root: &WorkspaceGitRootCandidate,
    workspace_path: &Path,
    repo_root: &Path,
) {
    let repo_root = path_to_string(repo_root);
    if let Some(existing) = repos.iter_mut().find(|item| item.repo_root == repo_root) {
        if !existing.root_ids.contains(&workspace_root.id) {
            existing.root_ids.push(workspace_root.id.clone());
        }
        return;
    }
    repos.push(WorkspaceGitRoot {
        id: format!("{}:{}", workspace_root.id, repo_root),
        name: repo_display_name(repo_root.as_str(), &workspace_root.name),
        path: path_to_string(workspace_path),
        is_submodule: is_git_file(repo_root.as_str()),
        repo_root,
        root_ids: vec![workspace_root.id.clone()],
    });
}

pub(super) fn is_git_file(repo_root: &str) -> bool {
    fs::symlink_metadata(Path::new(repo_root).join(".git"))
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

pub(super) fn collect_nested_git_roots(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    remaining_dirs: &mut usize,
    repos: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > max_depth || *remaining_dirs == 0 {
        return Ok(());
    }
    if depth > 0 && should_skip_git_root_scan_dir(dir) {
        return Ok(());
    }
    *remaining_dirs = (*remaining_dirs).saturating_sub(1);
    if dir.join(".git").exists() && !repos.iter().any(|repo| repo == dir) {
        repos.push(dir.to_path_buf());
    }
    if depth == max_depth {
        return Ok(());
    }
    let Ok(read) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in read {
        if *remaining_dirs == 0 {
            return Ok(());
        }
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        if should_skip_git_root_scan_dir(&path) {
            continue;
        }
        collect_nested_git_roots(&path, depth + 1, max_depth, remaining_dirs, repos)?;
    }
    Ok(())
}

pub(super) fn should_skip_git_root_scan_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".cache"
            | "__pycache__"
            | ".venv"
            | "venv"
    )
}

pub(super) fn repo_display_name(repo_root: &str, fallback: &str) -> String {
    Path::new(repo_root)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}
