use super::*;

pub(super) fn canonical_repo_root(repo_root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(repo_root);
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("resolve repo root {}: {e}", root.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "Repo root is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

pub(super) fn resolve_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = sanitize_relative_path(relative)?;
    let target = root.join(requested);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))?;
    ensure_inside(root, &canonical)?;
    Ok(strip_unc(&canonical))
}

pub(super) fn resolve_resource_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = sanitize_relative_path(relative)?;
    let target = root.join(&requested);
    if requested.as_os_str().is_empty() {
        return Ok(target);
    }
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    ensure_inside(root, &parent_canonical)?;
    Ok(target)
}

pub(super) fn resolve_writable_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let target = resolve_resource_path(root, relative)?;
    if target == root {
        return Err("Cannot write the workspace root".to_string());
    }
    Ok(target)
}

pub(super) fn resolve_existing_loose_file_path(path: &str) -> Result<PathBuf, String> {
    let target = loose_file_path(path)?;
    target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))
}

pub(super) fn resolve_writable_loose_file_path(path: &str) -> Result<PathBuf, String> {
    let target = loose_file_path(path)?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    parent
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    Ok(target)
}

pub(super) fn loose_file_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Loose file path cannot be empty".into());
    }
    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        return Err("Loose file path must be absolute".into());
    }
    Ok(target)
}

pub(super) fn sanitize_relative_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = Path::new(trimmed);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => return Err("Workspace paths cannot contain '..'".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("Workspace paths must be relative".into());
            }
        }
    }
    Ok(out)
}

pub(super) fn strip_unc(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

pub(super) fn ensure_inside(root: &Path, target: &Path) -> Result<(), String> {
    let clean_root = strip_unc(&root.canonicalize().unwrap_or_else(|_| root.to_path_buf()));
    let clean_target = strip_unc(target);
    if clean_target.starts_with(&clean_root) || target.starts_with(root) {
        Ok(())
    } else {
        Err(format!(
            "Path escapes workspace root: {} is outside {}",
            target.display(),
            root.display()
        ))
    }
}

/// Atomically replace `target` with `tmp`.
///
/// Every supported platform replaces an existing regular file in one step:
/// POSIX `rename(2)` and Windows `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`
/// (what `std::fs::rename` maps to). The previous target bytes therefore stay
/// in place until the new bytes are committed, so a failed replace never leaves
/// the workspace without its old contents. Never delete the target first — the
/// old delete-then-rename sequence lost the only copy when the rename failed.
pub(super) fn replace_file(tmp: &Path, target: &Path) -> std::io::Result<()> {
    crate::atomic_replace::retry(|| fs::rename(tmp, target))
}

pub(super) fn reject_workspace_root_target(
    root: &Path,
    target: &Path,
    operation: &str,
) -> Result<(), String> {
    if target == root {
        Err(format!("Cannot {operation} the workspace root"))
    } else {
        Ok(())
    }
}

pub(super) fn reject_protected_write(root: &Path, target: &Path) -> Result<(), String> {
    let clean_root = strip_unc(&root.canonicalize().unwrap_or_else(|_| root.to_path_buf()));
    let clean_target = strip_unc(target);
    let relative = clean_target
        .strip_prefix(&clean_root)
        .or_else(|_| target.strip_prefix(root))
        .map_err(|_| "Path escapes workspace root".to_string())?;
    if relative
        .components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
    {
        return Err("Writing inside .git is not allowed".into());
    }
    Ok(())
}

pub(super) fn reject_protected_loose_write(target: &Path) -> Result<(), String> {
    if target
        .components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
    {
        return Err("Writing inside .git is not allowed".into());
    }
    Ok(())
}

pub(super) fn path_to_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    // Windows canonicalize() yields `\\?\C:\...`; strip the verbatim prefix so
    // repo roots compare equal to non-canonical paths from callers/tests.
    let stripped = raw
        .strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
        .unwrap_or(raw.as_ref());
    stripped.to_string()
}

pub(super) fn path_for_display(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value
}

pub(super) fn relative_path(root: &Path, target: &Path) -> Result<String, String> {
    let clean_root = strip_unc(&root.canonicalize().unwrap_or_else(|_| root.to_path_buf()));
    let clean_target = strip_unc(target);
    let rel = clean_target
        .strip_prefix(&clean_root)
        .or_else(|_| target.strip_prefix(root))
        .map_err(|_| "Path escapes workspace root".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

pub(super) fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn hash_mismatch_error(expected: &str, found: &str) -> String {
    format!("hash-mismatch: File changed on disk; expected hash {expected}, found {found}")
}
