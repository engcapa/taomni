use crate::lsp::limits::JDTLS_WORKSPACE_MARKER;
use sha2::Digest;
use std::collections::hash_map::DefaultHasher;
use std::hash::Hash;
use std::hash::Hasher;
use std::path::Path;
use std::path::PathBuf;

/// Root that holds every per-workspace jdtls `-data` directory.
///
/// Windows keeps the historical `%LOCALAPPDATA%\jdtls-ws`; other platforms use the
/// user cache dir (`~/.cache/jdtls-ws` on Linux, `~/Library/Caches/jdtls-ws` on
/// macOS) so the location is ours to manage rather than left to the wrapper script.
pub(in crate::lsp) fn jdtls_data_root() -> PathBuf {
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local).join("jdtls-ws");
    }
    #[cfg(not(windows))]
    if let Some(cache) = dirs::cache_dir() {
        return cache.join("jdtls-ws");
    }
    std::env::temp_dir().join("jdtls-ws")
}

/// Per-workspace jdtls index/metadata directory. Keyed by the project scope path so
/// the same project reuses its index across restarts, while distinct projects stay
/// isolated (matching how IDEA keeps one index per project).
pub(in crate::lsp) fn jdtls_data_dir(workspace_root: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    workspace_root.to_string_lossy().hash(&mut hasher);
    let digest = format!("{:x}", hasher.finish());
    jdtls_data_root().join(digest)
}

/// Best-effort prune of stale jdtls index directories.
///
/// Each `-data` dir carries a `.taomni-workspace` marker naming the project it
/// indexes; when that project path no longer exists on disk, the whole index is
/// removed so abandoned/renamed projects do not accumulate unbounded disk usage.
/// Runs on a blocking thread and never fails the caller.
pub(in crate::lsp) fn prune_stale_jdtls_data_dirs() {
    let root = jdtls_data_root();
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let marker = dir.join(JDTLS_WORKSPACE_MARKER);
        let Ok(project) = std::fs::read_to_string(&marker) else {
            // No marker (older layout or partial dir): leave it alone to be safe.
            continue;
        };
        let project = project.trim();
        if project.is_empty() || Path::new(project).exists() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            log::warn!(
                "lsp: failed to prune stale jdtls data dir {} (project {project} gone): {error}",
                dir.display()
            );
        } else {
            log::info!(
                "lsp: pruned stale jdtls data dir {} (project {project} no longer exists)",
                dir.display()
            );
        }
    }
}

/// Create `data_dir` and stamp the `.taomni-workspace` marker with `workspace_root`
/// so [`prune_stale_jdtls_data_dirs`] can later tell which project it belongs to.
pub(in crate::lsp) fn ensure_jdtls_data_dir(
    data_dir: &Path,
    workspace_root: &Path,
) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("cannot create jdtls data dir {}: {e}", data_dir.display()))?;
    // Marker write is best-effort: a missing marker only disables pruning for this dir.
    let _ = std::fs::write(
        data_dir.join(JDTLS_WORKSPACE_MARKER),
        workspace_root.to_string_lossy().as_bytes(),
    );
    Ok(())
}
