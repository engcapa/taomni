use super::*;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportResult {
    pub imported: Vec<WorkspaceEntry>,
    pub failures: Vec<WorkspaceImportFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportFailure {
    pub source_path: String,
    pub message: String,
}

/// Preflight the entire batch before copying. Existing destinations (including
/// dangling links) never get replaced; independent I/O failures report exactly
/// which top-level items landed. Sources are read-only throughout the operation.
pub(super) fn import_workspace_paths(
    repo_root: &str,
    directory: &str,
    source_paths: &[String],
) -> Result<WorkspaceImportResult, String> {
    if source_paths.is_empty() {
        return Err("Nothing to import".into());
    }
    let root = canonical_repo_root(repo_root)?;
    let requested = sanitize_relative_path_exact(directory)?;
    let directory = root.join(requested);
    reject_protected_write(&root, &directory)?;
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("resolve target {}: {error}", directory.display()))?;
    ensure_inside(&root, &directory)?;
    reject_protected_write(&root, &directory)?;
    if !directory.is_dir() {
        return Err(format!(
            "Import target is not a directory: {}",
            directory.display()
        ));
    }

    let mut plans = Vec::new();
    let mut destinations = HashSet::new();
    for raw_path in source_paths {
        let source = PathBuf::from(raw_path);
        if !source.is_absolute() {
            return Err(format!(
                "Dropped path is not absolute: {}",
                source.display()
            ));
        }
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("stat {}: {error}", source.display()))?;
        let name = source
            .file_name()
            .ok_or_else(|| format!("Source path has no file name: {}", source.display()))?;
        let target = directory.join(name);
        reject_protected_write(&root, &target)?;
        // ASCII case folding also catches two batch names that alias on the
        // usual Windows/macOS filesystems. create_new remains the final arbiter.
        let key = if cfg!(windows) || cfg!(target_os = "macos") {
            target.to_string_lossy().to_lowercase()
        } else {
            target.to_string_lossy().into_owned()
        };
        if !destinations.insert(key) || resource_target_exists(&target)? {
            return Err(format!("Path already exists: {}", target.display()));
        }
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            let canonical_source = source
                .canonicalize()
                .map_err(|error| format!("resolve source {}: {error}", source.display()))?;
            if directory.starts_with(&canonical_source) {
                return Err(format!(
                    "Cannot copy directory {} inside itself",
                    source.display()
                ));
            }
        }
        plans.push((source, target));
    }

    let mut result = WorkspaceImportResult::default();
    for (source, target) in plans {
        let copied =
            copy_import_node(&source, &target).and_then(|()| workspace_entry(&root, &target));
        match copied {
            Ok(entry) => result.imported.push(entry),
            Err(message) => result.failures.push(WorkspaceImportFailure {
                source_path: source.to_string_lossy().into_owned(),
                message,
            }),
        }
    }
    Ok(result)
}

pub(super) fn copy_import_node(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("stat {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        // Preserve the link itself: never follow directory links or loops.
        return copy_resource_symlink(source, target, &metadata);
    }
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|error| format!("mkdir {}: {error}", target.display()))?;
        let result = (|| {
            for entry in fs::read_dir(source)
                .map_err(|error| format!("read directory {}: {error}", source.display()))?
            {
                let entry = entry
                    .map_err(|error| format!("read directory {}: {error}", source.display()))?;
                if entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(".git")
                {
                    return Err("Writing inside .git is not allowed".to_string());
                }
                copy_import_node(&entry.path(), &target.join(entry.file_name()))?;
            }
            fs::set_permissions(target, metadata.permissions())
                .map_err(|error| format!("set permissions {}: {error}", target.display()))
        })();
        return cleanup_failed_copy(result, target, true);
    }
    if !metadata.is_file() {
        return Err(format!("Unsupported source type: {}", source.display()));
    }
    let mut input = fs::File::open(source)
        .map_err(|error| format!("open source {}: {error}", source.display()))?;
    // No check-then-overwrite: concurrent imports cannot truncate an existing
    // regular file or follow an existing destination symlink.
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("create {}: {error}", target.display()))?;
    let result = (|| {
        std::io::copy(&mut input, &mut output).map_err(|error| {
            format!("copy {} -> {}: {error}", source.display(), target.display())
        })?;
        output
            .sync_all()
            .map_err(|error| format!("sync {}: {error}", target.display()))?;
        fs::set_permissions(target, metadata.permissions())
            .map_err(|error| format!("set permissions {}: {error}", target.display()))
    })();
    drop(output);
    cleanup_failed_copy(result, target, false)
}

pub(super) fn cleanup_failed_copy(
    result: Result<(), String>,
    target: &Path,
    directory: bool,
) -> Result<(), String> {
    let Err(error) = result else {
        return Ok(());
    };
    // Successful children may already have inherited read-only permissions.
    // Restore only this copy's own nodes, never a symlink's external target.
    let cleanup = make_copy_removable(target).and_then(|()| {
        if directory {
            fs::remove_dir_all(target)
        } else {
            fs::remove_file(target)
        }
    });
    match cleanup {
        Ok(()) => Err(error),
        Err(cleanup) => Err(format!(
            "{error}; partial copy cleanup failed at {}: {cleanup}",
            target.display()
        )),
    }
}

fn make_copy_removable(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    let mut permissions = metadata.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(permissions.mode() | if metadata.is_dir() { 0o700 } else { 0o600 });
    }
    #[cfg(windows)]
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            make_copy_removable(&entry?.path())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_import_paths(
    repo_root: String,
    directory: String,
    source_paths: Vec<String>,
) -> Result<WorkspaceImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_workspace_paths(&repo_root, &directory, &source_paths)
    })
    .await
    .map_err(|error| format!("Import task failed: {error}"))?
}
