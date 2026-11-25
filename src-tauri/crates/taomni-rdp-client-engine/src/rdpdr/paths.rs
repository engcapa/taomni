use std::fs;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

// ── Path sandboxing ────────────────────────────────────────────────────

/// Resolve `requested` (relative or starting with `/` or `\`) against
/// `root`, refusing any traversal that escapes `root`.
///
/// Returns the canonical path inside the root (which may not yet exist;
/// callers handle ENOENT). Used by every IO request handler.
pub fn safe_join(root: &Path, requested: &str) -> Result<PathBuf, String> {
    safe_join_from(root, root, requested)
}

pub(super) fn safe_join_from(root: &Path, base: &Path, requested: &str) -> Result<PathBuf, String> {
    let normalized = requested.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    let anchor = if normalized.starts_with('/') {
        root.to_path_buf()
    } else {
        base.to_path_buf()
    };
    let candidate = anchor.join(trimmed);
    normalize_inside(root, candidate)
}

pub(super) fn normalize_inside(root: &Path, candidate: PathBuf) -> Result<PathBuf, String> {
    let mut resolved = PathBuf::new();
    for c in candidate.components() {
        match c {
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err("rdpdr: path traversal rejected".into());
                }
            }
            Component::CurDir => {}
            Component::RootDir => {
                resolved.push("/");
            }
            Component::Prefix(p) => {
                resolved.push(p.as_os_str());
            }
            Component::Normal(seg) => {
                resolved.push(seg);
            }
        }
    }
    // Ensure the resolved path is still within root.
    if !resolved.starts_with(root) {
        return Err(format!(
            "rdpdr: refusing path '{}' outside mapped root '{}'",
            resolved.display(),
            root.display()
        ));
    }
    Ok(resolved)
}

/// Reject symlinks/reparse-style indirection in every existing component.
/// `safe_join` is lexical; this second check prevents an in-root symlink from
/// resolving to a path outside the mapped directory.
pub(super) fn validate_confined_path(root: &Path, candidate: &Path) -> Result<(), String> {
    let relative = candidate.strip_prefix(root).map_err(|_| {
        format!(
            "rdpdr: refusing path '{}' outside mapped root '{}'",
            candidate.display(),
            root.display()
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("rdpdr: invalid mapped path component".into());
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "rdpdr: symbolic links are not allowed in mapped paths ('{}')",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!(
                    "rdpdr: inspect mapped path '{}': {}",
                    current.display(),
                    error
                ));
            }
        }
    }
    Ok(())
}
