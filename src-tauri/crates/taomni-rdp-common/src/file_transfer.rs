//! Shared filesystem rules for RDP clipboard file transfer.
//!
//! Callers own announced paths, transfer quotas, request correlation and
//! staging lifetime. These helpers preserve bounded positional IO and the
//! platform safety flags used by both endpoints.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub fn clipboard_relative_name(root: &Path, path: &Path) -> Result<String, String> {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let name = rel
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("\\");
    if name.is_empty() {
        return Err(format!(
            "clipboard path '{}' has no file name",
            path.display()
        ));
    }
    if name.encode_utf16().count() >= 260 {
        return Err(format!(
            "clipboard file name '{}' exceeds 259 UTF-16 code units",
            name
        ));
    }
    Ok(name)
}

pub fn read_clipboard_file_range(
    path: &Path,
    position: u64,
    requested_size: u32,
) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|e| format!("open '{}': {}", path.display(), e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| format!("seek '{}': {}", path.display(), e))?;
    let max_chunk = 16 * 1024 * 1024;
    let size = usize::try_from(requested_size)
        .unwrap_or(usize::MAX)
        .min(max_chunk);
    let mut data = Vec::with_capacity(size);
    file.take(size as u64)
        .read_to_end(&mut data)
        .map_err(|e| format!("read '{}': {}", path.display(), e))?;
    Ok(data)
}
pub fn remote_clipboard_safe_path(root: &Path, remote_name: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    let mut saw_part = false;
    for part in remote_name.split(['\\', '/']) {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(format!("remote clipboard path '{}' is unsafe", remote_name));
        }
        saw_part = true;
        path.push(part);
    }
    if !saw_part {
        return Err("remote clipboard file has an empty name".to_string());
    }
    Ok(path)
}

pub fn remote_top_level_name(remote_name: &str) -> Option<PathBuf> {
    remote_name
        .split(['\\', '/'])
        .find(|part| !part.trim().is_empty() && *part != "." && *part != "..")
        .map(PathBuf::from)
}

pub fn write_remote_file_chunk(path: &Path, position: u64, data: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|e| format!("open '{}': {}", path.display(), e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| format!("seek '{}': {}", path.display(), e))?;
    file.write_all(data)
        .map_err(|e| format!("write '{}': {}", path.display(), e))
}
pub fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("create private directory '{}': {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure directory '{}': {error}", path.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
pub fn process_is_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn process_is_alive(_pid: u32) -> bool {
    // Avoid deleting another process's active transfer on platforms where this
    // module has no inexpensive process-existence probe.
    true
}

#[cfg(test)]
#[path = "file_transfer_tests.rs"]
mod tests;
