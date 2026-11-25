//! Resolve staging paths before reserving or opening them.

use std::path::{Component, Path, PathBuf};

use super::DownloadError;

/// Restrict renderer paths to the profile-owned staging directory. Resolve
/// existing ancestors first: macOS /var aliases and other directory aliases
/// must compare against the same canonical root.
pub fn validate_download_paths_within_root(
    partial: &Path,
    completed: &Path,
    root: &Path,
) -> Result<(), DownloadError> {
    let root = std::fs::canonicalize(root).map_err(|error| {
        DownloadError::InvalidPath(format!("download root is unavailable: {error}"))
    })?;
    let partial = canonical_candidate(partial)?;
    let completed = canonical_candidate(completed)?;
    if reservation_key(&partial) == reservation_key(&completed) {
        return Err(DownloadError::InvalidPath(
            "partial and completed paths must differ".into(),
        ));
    }
    for path in [partial, completed] {
        if !path.starts_with(&root) {
            return Err(DownloadError::InvalidPath(format!(
                "download path is outside the staging root: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

/// Canonicalize existing ancestors while retaining a not-yet-created suffix.
/// Existing final symlinks (including dangling links) and special files cannot
/// be transfer targets. Parent aliases are resolved, not retained in keys.
pub(super) fn canonical_candidate(path: &Path) -> Result<PathBuf, DownloadError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(DownloadError::InvalidPath(
            "download paths must be absolute file paths".into(),
        ));
    }
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(DownloadError::InvalidPath(format!(
            "download path contains parent traversal: {}",
            path.display()
        )));
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(DownloadError::InvalidPath(
                    "download path must be a regular file, never a symlink".into(),
                ));
            }
            Ok(std::fs::canonicalize(path)?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut ancestor = path
                .parent()
                .ok_or_else(|| DownloadError::InvalidPath("download path has no parent".into()))?;
            loop {
                match std::fs::symlink_metadata(ancestor) {
                    Ok(_) => break,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        ancestor = ancestor.parent().ok_or_else(|| {
                            DownloadError::InvalidPath("download parent is unavailable".into())
                        })?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            let canonical = std::fs::canonicalize(ancestor)?;
            if !canonical.is_dir() {
                return Err(DownloadError::InvalidPath(
                    "download parent is not a directory".into(),
                ));
            }
            let suffix = path.strip_prefix(ancestor).map_err(|error| {
                DownloadError::InvalidPath(format!("download suffix is invalid: {error}"))
            })?;
            Ok(canonical.join(suffix))
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) fn reservation_key(path: &Path) -> PathBuf {
    // Windows and the usual macOS filesystem are case insensitive. Conservatively
    // fold future names on macOS too, including on case-sensitive volumes.
    #[cfg(any(windows, target_os = "macos"))]
    {
        PathBuf::from(path.as_os_str().to_string_lossy().to_lowercase())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        path.to_path_buf()
    }
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
