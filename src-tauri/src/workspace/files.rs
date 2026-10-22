use super::*;

pub(super) fn list_workspace_entries(
    root: &Path,
    target: &Path,
) -> Result<Vec<WorkspaceEntry>, String> {
    let mut entries = Vec::new();
    let read = fs::read_dir(target).map_err(|e| format!("read {}: {e}", target.display()))?;
    for item in read {
        let Ok(item) = item else {
            continue;
        };
        let path = item.path();
        if let Ok(entry) = workspace_entry(root, &path) {
            entries.push(entry);
        }
    }
    entries.sort_by(
        |a, b| match (a.file_type.as_str() == "dir", b.file_type.as_str() == "dir") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        },
    );
    Ok(entries)
}

pub(super) fn collect_workspace_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    max_files: usize,
    files: &mut Vec<WorkspaceEntry>,
) -> Result<(), String> {
    if depth > max_depth || files.len() >= max_files {
        return Ok(());
    }
    // Skip dependency / build trees on every platform; walking `node_modules`
    // or `target` is a common Windows CPU spike when the flat index builds.
    if depth > 0 && should_skip_git_root_scan_dir(dir) {
        return Ok(());
    }
    for entry in list_workspace_entries(root, dir)? {
        if entry.path == ".git" || entry.path.starts_with(".git/") {
            continue;
        }
        if should_skip_workspace_entry_path(&entry.path) {
            continue;
        }
        match entry.file_type.as_str() {
            "file" => {
                files.push(entry);
                if files.len() >= max_files {
                    return Ok(());
                }
            }
            "dir" if depth < max_depth => {
                let child = resolve_existing_path(root, &entry.path)?;
                collect_workspace_files(root, &child, depth + 1, max_depth, max_files, files)?;
                if files.len() >= max_files {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn should_skip_workspace_entry_path(path: &str) -> bool {
    path.split(['/', '\\']).any(|segment| {
        matches!(
            segment,
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
    })
}

/// Atomic writes stage content in a sibling `.taomni-write-<uuid>` temp file
/// before replacing the target. Those artifacts are private to the write
/// pipeline, so watcher consumers must never observe them as workspace
/// changes — an unmatched temp event would clobber user-facing apply
/// confirmations with a bogus "file changed on disk" notice.
pub(crate) fn is_workspace_write_temp_path(path: &str) -> bool {
    path.rsplit(['/', '\\'])
        .next()
        .is_some_and(|basename| basename.starts_with(".taomni-write-"))
}

pub(super) fn workspace_entry(root: &Path, path: &Path) -> Result<WorkspaceEntry, String> {
    let symlink_meta =
        fs::symlink_metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let file_type = if symlink_meta.file_type().is_symlink() {
        "symlink"
    } else if symlink_meta.is_dir() {
        "dir"
    } else if symlink_meta.is_file() {
        "file"
    } else {
        "other"
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(WorkspaceEntry {
        name: name.clone(),
        path: relative_path(root, path)?,
        file_type: file_type.to_string(),
        size: symlink_meta.len(),
        mtime: mtime_secs(&symlink_meta),
        is_hidden: name.starts_with('.'),
    })
}
