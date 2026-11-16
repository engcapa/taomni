//! Traverse a host export through pinned directories, then consume the same
//! regular-file handle used for verification. Never reopen a checked pathname.
use crate::plugin::data_contract::{require_directory, require_file, validate_relative};
use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
};

pub(super) fn open(root: &Path, relative: &str) -> Result<File, String> {
    validate_relative(relative).map_err(|e| e.to_string())?;
    require_directory(root).map_err(|e| e.to_string())?;
    if std::fs::canonicalize(root).map_err(|e| e.to_string())? != root {
        return Err("Plugin snapshot root changed".into());
    }
    let file = open_beneath(root, relative).map_err(|e| e.to_string())?;
    require_file(&file.metadata().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(file)
}

#[cfg(unix)]
fn open_beneath(root: &Path, relative: &str) -> io::Result<File> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        },
    };
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    let parts: Vec<_> = relative.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        let component = CString::new(*part).map_err(io::Error::other)?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if index + 1 == parts.len() {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // Each lookup is relative to an already opened, non-linked directory.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), component.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let next = unsafe { File::from_raw_fd(fd) };
        if index + 1 == parts.len() {
            return Ok(next);
        }
        directory = next;
    }
    Err(io::Error::other("missing snapshot filename"))
}

#[cfg(windows)]
fn open_beneath(root: &Path, relative: &str) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    fn directory(path: &Path) -> io::Result<File> {
        // Deny delete sharing while descendants are opened: a checked parent
        // cannot be renamed or replaced with a junction between lookups.
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)?;
        let metadata = handle.metadata()?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("linked snapshot directory"));
        }
        Ok(handle)
    }
    let mut pinned = vec![directory(root)?];
    let mut path = root.to_path_buf();
    let parts: Vec<_> = relative.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        if index + 1 == parts.len() {
            return OpenOptions::new()
                .read(true)
                .share_mode(0x1 | 0x2)
                .custom_flags(0x0020_0000)
                .open(path);
        }
        pinned.push(directory(&path)?);
    }
    Err(io::Error::other("missing snapshot filename"))
}
