use super::limits::FILETIME_UNIX_EPOCH;
use super::limits::MAX_FILE_ITEMS;
use crate::rdp::session::clipboard_relative_name;
use crate::rdp::session::process_is_alive;
use ironrdp::cliprdr::pdu::ClipboardFileAttributes;
use ironrdp::cliprdr::pdu::FileDescriptor;
use ironrdp::core::IntoOwned as _;
use std::path::Path;
use std::path::PathBuf;

/// A host file or directory offered to the client, in announcement order
/// (`FileContentsRequest::index` is a position in this list).
#[derive(Clone, Debug)]
pub(super) struct AnnouncedFile {
    pub(super) path: PathBuf,
    pub(super) size: u64,
    pub(super) is_directory: bool,
}

pub(super) fn filetime(meta: &std::fs::Metadata) -> Option<u64> {
    let since_epoch = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    u64::try_from(since_epoch.as_nanos() / 100)
        .ok()
        .map(|ticks| ticks + FILETIME_UNIX_EPOCH)
}

/// Expand the host file list (directories recursively, in name order) into
/// CLIPRDR descriptors. Any entry the wire cannot carry rejects the whole
/// list, because ironrdp would drop it and shift every later index.
pub(super) fn collect_announced_files(
    roots: &[PathBuf],
    max_bytes: u64,
) -> Result<(Vec<FileDescriptor>, Vec<AnnouncedFile>), String> {
    let mut descriptors = Vec::new();
    let mut files = Vec::new();
    let mut total = 0u64;
    for root in roots {
        let path = root
            .canonicalize()
            .map_err(|e| format!("canonicalize '{}': {e}", root.display()))?;
        let base = path.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
        collect_announced(
            &base,
            &path,
            max_bytes,
            &mut total,
            &mut descriptors,
            &mut files,
        )?;
    }
    Ok((descriptors, files))
}

pub(super) fn collect_announced(
    base: &Path,
    path: &Path,
    max_bytes: u64,
    total: &mut u64,
    descriptors: &mut Vec<FileDescriptor>,
    files: &mut Vec<AnnouncedFile>,
) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("metadata '{}': {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!(
            "'{}' is a symbolic link; links are not transferred",
            path.display()
        ));
    }
    let is_directory = meta.is_dir();
    let size = if is_directory { 0 } else { meta.len() };
    *total = total.saturating_add(size);
    if *total > max_bytes {
        return Err(format!(
            "files exceed the {} MiB clipboard limit",
            max_bytes / (1024 * 1024)
        ));
    }
    if files.len() >= MAX_FILE_ITEMS {
        return Err(format!("more than {MAX_FILE_ITEMS} file items"));
    }
    // Also enforces the 259 UTF-16 unit limit of the descriptor name field.
    let wire_name = clipboard_relative_name(base, path)?;
    let (relative_path, name) = match wire_name.rsplit_once('\\') {
        Some((directory, name)) => (Some(directory.to_string()), name.to_string()),
        None => (None, wire_name.clone()),
    };
    let mut descriptor = FileDescriptor::new(name).with_attributes(if is_directory {
        ClipboardFileAttributes::DIRECTORY
    } else {
        ClipboardFileAttributes::NORMAL
    });
    if let Some(relative_path) = relative_path {
        descriptor = descriptor.with_relative_path(relative_path);
    }
    if !is_directory {
        descriptor = descriptor.with_file_size(size);
    }
    if let Some(time) = filetime(&meta) {
        descriptor = descriptor.with_last_write_time(time);
    }
    descriptors.push(descriptor);
    files.push(AnnouncedFile {
        path: path.to_path_buf(),
        size,
        is_directory,
    });
    if is_directory {
        let mut entries = std::fs::read_dir(path)
            .and_then(|entries| entries.collect::<Result<Vec<_>, _>>())
            .map_err(|e| format!("read directory '{}': {e}", path.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            collect_announced(base, &entry.path(), max_bytes, total, descriptors, files)?;
        }
    }
    Ok(())
}

pub(super) fn staging_base() -> PathBuf {
    #[cfg(unix)]
    let name = format!("taomni-rdp-server-clipboard-{}", unsafe { libc::geteuid() });
    #[cfg(not(unix))]
    let name = "taomni-rdp-server-clipboard".to_string();
    std::env::temp_dir().join(name)
}

pub(super) fn process_staging_root() -> PathBuf {
    staging_base().join(format!("process-{}", std::process::id()))
}

/// Remove staging left behind by server processes that no longer run.
pub(super) fn cleanup_stale_staging() {
    let Ok(entries) = std::fs::read_dir(staging_base()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let dead = name
            .strip_prefix("process-")
            .and_then(|pid| pid.parse::<u32>().ok())
            .is_some_and(|pid| pid != std::process::id() && !process_is_alive(pid));
        if dead {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// A private download directory, removed when dropped.
#[derive(Debug)]
pub(super) struct StagingDir(pub(super) PathBuf);

impl Drop for StagingDir {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(path = %self.0.display(), %error, "failed to clean RDP server clipboard staging");
        }
    }
}
