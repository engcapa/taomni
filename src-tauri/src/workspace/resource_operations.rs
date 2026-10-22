use super::*;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceResourceOperation {
    Create {
        path: String,
        #[serde(default)]
        overwrite: bool,
        #[serde(default)]
        ignore_if_exists: bool,
    },
    Rename {
        from_path: String,
        to_path: String,
        #[serde(default)]
        to_repo_root: Option<String>,
        #[serde(default)]
        overwrite: bool,
        #[serde(default)]
        ignore_if_exists: bool,
    },
    Delete {
        path: String,
        #[serde(default)]
        recursive: bool,
        #[serde(default)]
        ignore_if_not_exists: bool,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceResourceOperationResult {
    pub ignored: bool,
}

/// Apply an LSP CreateFile/RenameFile/DeleteFile inside a workspace root while
/// keeping the same path traversal and protected-path guards as manual actions.
#[tauri::command]
pub fn workspace_apply_resource_operation(
    repo_root: String,
    operation: WorkspaceResourceOperation,
) -> Result<WorkspaceResourceOperationResult, String> {
    let root = canonical_repo_root(&repo_root)?;
    match operation {
        WorkspaceResourceOperation::Create {
            path,
            overwrite,
            ignore_if_exists,
        } => {
            let target = resolve_writable_path(&root, &path)?;
            reject_protected_write(&root, &target)?;
            if resource_target_exists(&target)? {
                if overwrite {
                    let metadata = fs::symlink_metadata(&target)
                        .map_err(|error| format!("stat {}: {error}", target.display()))?;
                    if metadata.is_dir() && !metadata.file_type().is_symlink() {
                        return Err(format!(
                            "CreateFile cannot overwrite directory: {}",
                            target.display()
                        ));
                    }
                    create_empty_resource_replacing(&target)?;
                } else if ignore_if_exists {
                    return Ok(WorkspaceResourceOperationResult { ignored: true });
                } else {
                    return Err(format!("Path already exists: {}", target.display()));
                }
            } else {
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(|e| format!("create {}: {e}", target.display()))?;
            }
        }
        WorkspaceResourceOperation::Rename {
            from_path,
            to_path,
            to_repo_root,
            overwrite,
            ignore_if_exists,
        } => {
            let from = resolve_resource_path(&root, &from_path)?;
            reject_workspace_root_target(&root, &from, "rename")?;
            reject_protected_write(&root, &from)?;
            let from_metadata = match fs::symlink_metadata(&from) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(format!("Path does not exist: {}", from.display()));
                }
                Err(error) => return Err(format!("stat {}: {error}", from.display())),
            };
            let destination_root = match to_repo_root.as_deref().map(str::trim) {
                Some(path) if !path.is_empty() => canonical_repo_root(path)?,
                _ => root.clone(),
            };
            let to = resolve_writable_path(&destination_root, &to_path)?;
            reject_protected_write(&destination_root, &to)?;
            if from == to {
                return Ok(WorkspaceResourceOperationResult { ignored: true });
            }
            if from_metadata.is_dir()
                && !from_metadata.file_type().is_symlink()
                && to.starts_with(&from)
            {
                return Err(format!(
                    "Cannot move directory {} inside itself",
                    from.display()
                ));
            }
            if resource_target_exists(&to)? {
                if overwrite {
                    move_resource_replacing(&from, &to)?;
                } else if ignore_if_exists {
                    return Ok(WorkspaceResourceOperationResult { ignored: true });
                } else {
                    return Err(format!("Path already exists: {}", to.display()));
                }
            } else {
                move_resource_across_roots(&from, &to)?;
            }
        }
        WorkspaceResourceOperation::Delete {
            path,
            recursive,
            ignore_if_not_exists,
        } => {
            let target = resolve_writable_path(&root, &path)?;
            reject_workspace_root_target(&root, &target, "delete")?;
            reject_protected_write(&root, &target)?;
            if !resource_target_exists(&target)? {
                if ignore_if_not_exists {
                    return Ok(WorkspaceResourceOperationResult { ignored: true });
                }
                return Err(format!("Path does not exist: {}", target.display()));
            }
            remove_resource_target(&target, recursive)?;
        }
    }
    Ok(WorkspaceResourceOperationResult { ignored: false })
}

pub(super) fn remove_resource_target(target: &Path, recursive: bool) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        if recursive {
            fs::remove_dir_all(target).map_err(|e| format!("rmdir {}: {e}", target.display()))
        } else {
            fs::remove_dir(target).map_err(|e| format!("rmdir {}: {e}", target.display()))
        }
    } else {
        fs::remove_file(target).map_err(|e| format!("remove {}: {e}", target.display()))
    }
}

pub(super) fn resource_target_exists(target: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(target) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("stat {}: {error}", target.display())),
    }
}

pub(super) fn resource_backup_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot create backup path for {}", target.display()))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("Cannot create backup path for {}", target.display()))?;
    for _ in 0..1_000 {
        let sequence = RESOURCE_BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut backup_name = OsString::from(".");
        backup_name.push(file_name);
        backup_name.push(format!(
            ".taomni-workspace-edit-backup-{}-{sequence}",
            std::process::id()
        ));
        let candidate = parent.join(backup_name);
        if !resource_target_exists(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Cannot allocate a backup path next to {}",
        target.display()
    ))
}

pub(super) fn create_empty_resource_replacing(target: &Path) -> Result<(), String> {
    let staged = resource_backup_path(target)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged)
        .map_err(|error| format!("create staged file {}: {error}", staged.display()))?;
    if let Err(error) = move_resource_replacing(&staged, target) {
        let cleanup_error = match resource_target_exists(&staged) {
            Ok(true) => remove_resource_target(&staged, false).err(),
            Ok(false) => None,
            Err(error) => Some(error),
        };
        return Err(format!(
            "create {}: {error}{}",
            target.display(),
            cleanup_error
                .map(|cleanup| format!("; staged file cleanup failed: {cleanup}"))
                .unwrap_or_default()
        ));
    }
    Ok(())
}

pub(super) fn move_resource_replacing(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Ok(()) => return Ok(()),
        Err(direct_error) => {
            let backup = resource_backup_path(to)?;
            fs::rename(to, &backup).map_err(|backup_error| {
                format!(
                    "replace {} -> {}: {direct_error}; cannot preserve existing destination: {backup_error}",
                    from.display(),
                    to.display()
                )
            })?;

            match move_resource_across_roots(from, to) {
                Ok(()) => {
                    if let Err(error) = remove_resource_target(&backup, true) {
                        log::warn!(
                            "workspace rename succeeded but destination backup cleanup failed at {}: {}",
                            backup.display(),
                            error
                        );
                    }
                    return Ok(());
                }
                Err(move_error) => {
                    let partial_cleanup_error = match resource_target_exists(to) {
                        Ok(true) => remove_resource_target(to, true).err(),
                        Ok(false) => None,
                        Err(error) => Some(error),
                    };
                    let restore_error = fs::rename(&backup, to).err();
                    return Err(format!(
                        "replace {} -> {} failed: {move_error}{}{}",
                        from.display(),
                        to.display(),
                        partial_cleanup_error
                            .map(|error| format!("; partial destination cleanup failed: {error}"))
                            .unwrap_or_default(),
                        restore_error
                            .map(|error| format!("; destination restore failed: {error}"))
                            .unwrap_or_default()
                    ));
                }
            }
        }
    }
}

pub(super) fn move_resource_across_roots(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Ok(()) => return Ok(()),
        Err(rename_error) => {
            if let Err(copy_error) = copy_resource_target(from, to) {
                let cleanup_error = match resource_target_exists(to) {
                    Ok(true) => remove_resource_target(to, true)
                        .err()
                        .map(|error| format!("partial destination cleanup failed: {error}")),
                    Ok(false) => None,
                    Err(error) => Some(format!("partial destination inspection failed: {error}")),
                };
                return Err(format!(
                    "move {} -> {}: {rename_error}; copy fallback failed: {copy_error}{}",
                    from.display(),
                    to.display(),
                    cleanup_error
                        .map(|error| format!("; {error}"))
                        .unwrap_or_default()
                ));
            }
            if let Err(remove_error) = remove_resource_target(from, true) {
                let cleanup_error = remove_resource_target(to, true).err();
                return Err(format!(
                    "move {} -> {}: source cleanup failed: {remove_error}{}",
                    from.display(),
                    to.display(),
                    cleanup_error
                        .map(|error| format!("; destination rollback failed: {error}"))
                        .unwrap_or_default()
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn copy_resource_target(from: &Path, to: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(from).map_err(|error| format!("stat {}: {error}", from.display()))?;
    if metadata.file_type().is_symlink() {
        return copy_resource_symlink(from, to, &metadata);
    }
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::create_dir(to).map_err(|error| format!("mkdir {}: {error}", to.display()))?;
        for entry in fs::read_dir(from)
            .map_err(|error| format!("read directory {}: {error}", from.display()))?
        {
            let entry = entry.map_err(|error| format!("read {}: {error}", from.display()))?;
            copy_resource_target(&entry.path(), &to.join(entry.file_name()))?;
        }
        fs::set_permissions(to, metadata.permissions())
            .map_err(|error| format!("set permissions {}: {error}", to.display()))?;
        return Ok(());
    }
    fs::copy(from, to)
        .map(|_| ())
        .map_err(|error| format!("copy {} -> {}: {error}", from.display(), to.display()))
}

#[cfg(unix)]
pub(super) fn copy_resource_symlink(
    from: &Path,
    to: &Path,
    _metadata: &fs::Metadata,
) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let target =
        fs::read_link(from).map_err(|error| format!("read symlink {}: {error}", from.display()))?;
    symlink(&target, to).map_err(|error| {
        format!(
            "copy symlink {} -> {}: {error}",
            from.display(),
            to.display()
        )
    })
}

#[cfg(windows)]
pub(super) fn copy_resource_symlink(
    from: &Path,
    to: &Path,
    metadata: &fs::Metadata,
) -> Result<(), String> {
    use std::os::windows::fs::{FileTypeExt, symlink_dir, symlink_file};

    let target =
        fs::read_link(from).map_err(|error| format!("read symlink {}: {error}", from.display()))?;
    let result = if metadata.file_type().is_symlink_dir() {
        symlink_dir(&target, to)
    } else {
        symlink_file(&target, to)
    };
    result.map_err(|error| {
        format!(
            "copy symlink {} -> {}: {error}",
            from.display(),
            to.display()
        )
    })
}
