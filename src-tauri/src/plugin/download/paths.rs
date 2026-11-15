use std::path::Path;

use super::{DownloadError, validate_download_paths};

/// Restrict renderer supplied download paths to the profile-owned staging
/// directory. The IPC command accepts paths so the renderer can retain a task
/// identity across restarts, but it must never make the native downloader
/// write an arbitrary file.
pub fn validate_download_paths_within_root(
    partial: &Path,
    completed: &Path,
    root: &Path,
) -> Result<(), DownloadError> {
    validate_download_paths(partial, completed)?;
    if !partial.is_absolute() || !completed.is_absolute() {
        return Err(DownloadError::InvalidPath(
            "download paths must be absolute".into(),
        ));
    }
    if root.as_os_str().is_empty() {
        return Err(DownloadError::InvalidPath(
            "download root must be non-empty".into(),
        ));
    }
    let root = std::fs::canonicalize(root).map_err(|error| {
        DownloadError::InvalidPath(format!("download root is unavailable: {error}"))
    })?;
    for path in [partial, completed] {
        if path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(DownloadError::InvalidPath(format!(
                "download path contains parent traversal: {}",
                path.display()
            )));
        }
        if !path.starts_with(&root) {
            return Err(DownloadError::InvalidPath(format!(
                "download path is outside the staging root: {}",
                path.display()
            )));
        }
        let parent = path.parent().ok_or_else(|| {
            DownloadError::InvalidPath(format!("download path has no parent: {}", path.display()))
        })?;
        let existing_parent = nearest_existing_parent(parent).ok_or_else(|| {
            DownloadError::InvalidPath(format!(
                "download path parent cannot be resolved: {}",
                parent.display()
            ))
        })?;
        let canonical_parent = std::fs::canonicalize(existing_parent).map_err(|error| {
            DownloadError::InvalidPath(format!("download path parent is invalid: {error}"))
        })?;
        if !canonical_parent.starts_with(&root) {
            return Err(DownloadError::InvalidPath(format!(
                "download path is outside the staging root: {}",
                path.display()
            )));
        }
        // Reject existing and dangling symlinks before opening a partial file.
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            if metadata.file_type().is_symlink() {
                return Err(DownloadError::InvalidPath(format!(
                    "download path must not be a symlink: {}",
                    path.display()
                )));
            }
        }
        if path.exists() {
            let canonical_path = std::fs::canonicalize(path).map_err(|error| {
                DownloadError::InvalidPath(format!("download path is invalid: {error}"))
            })?;
            if !canonical_path.starts_with(&root) {
                return Err(DownloadError::InvalidPath(format!(
                    "download path resolves outside the staging root: {}",
                    path.display()
                )));
            }
        }
    }
    Ok(())
}

fn nearest_existing_parent(mut path: &Path) -> Option<&Path> {
    while !path.exists() {
        path = path.parent()?;
    }
    Some(path)
}
