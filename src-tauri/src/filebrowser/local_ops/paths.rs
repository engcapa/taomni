use super::model::{OpError, OpResult};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(super) fn validate_name(name: &str) -> OpResult<()> {
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
        || stem
            .strip_prefix("LPT")
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"));
    if name.is_empty()
        || matches!(name, "." | "..")
        || reserved
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || name.chars().count() > 255
    {
        return Err(OpError::new(
            "invalid_name",
            "The name contains reserved or invalid characters",
        ));
    }
    Ok(())
}

pub(super) fn absolute_entry(path: &Path) -> OpResult<PathBuf> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(OpError::new(
            "invalid_path",
            "An absolute path without '..' is required",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| OpError::new("invalid_path", "Filesystem roots cannot be modified"))?;
    let name = path
        .file_name()
        .ok_or_else(|| OpError::new("invalid_path", "A file or folder name is required"))?;
    let parent = fs::canonicalize(parent).map_err(|e| OpError::io("resolve parent", parent, e))?;
    Ok(parent.join(name))
}

pub(super) fn destination_dir(path: &Path) -> OpResult<PathBuf> {
    let canonical =
        fs::canonicalize(path).map_err(|e| OpError::io("resolve directory", path, e))?;
    if !canonical.is_dir() {
        return Err(OpError::new(
            "not_directory",
            format!("Not a directory: {}", path.display()),
        ));
    }
    Ok(canonical)
}

pub(super) fn reject_descendant(source: &Path, dest: &Path) -> OpResult<()> {
    let meta = fs::symlink_metadata(source).map_err(|e| OpError::io("stat", source, e))?;
    // A directory symlink is copied as a link, not traversed. Its own location
    // still may not be replaced; its target's descendants are not descendants
    // of the link being copied.
    if meta.is_dir() {
        let canonical =
            fs::canonicalize(source).map_err(|e| OpError::io("resolve source", source, e))?;
        if dest.starts_with(&canonical) {
            return Err(OpError::new(
                "invalid_target",
                "A folder cannot be copied or moved into itself or a descendant",
            ));
        }
    }
    if source == dest {
        return Err(OpError::new(
            "invalid_target",
            "An item cannot be dropped onto itself",
        ));
    }
    Ok(())
}

pub(super) fn split_name(name: &str, directory: bool) -> (&str, &str) {
    if !directory {
        if let Some(index) = name.rfind('.').filter(|i| *i > 0) {
            return (&name[..index], &name[index..]);
        }
    }
    (name, "")
}

pub(super) fn unique_path(
    dir: &Path,
    name: &str,
    directory: bool,
    copy_suffix: bool,
) -> OpResult<PathBuf> {
    let candidate = dir.join(name);
    if fs::symlink_metadata(&candidate).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(candidate);
    }
    let (stem, ext) = split_name(name, directory);
    for index in 1..100_000 {
        let suffix = if copy_suffix {
            if index == 1 {
                " - 副本".to_string()
            } else {
                format!(" - 副本 ({index})")
            }
        } else {
            format!(" ({})", index + 1)
        };
        let candidate = dir.join(format!("{stem}{suffix}{ext}"));
        match fs::symlink_metadata(&candidate) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(e) => return Err(OpError::io("stat destination", &candidate, e)),
            Ok(_) => {}
        }
    }
    Err(OpError::new(
        "name_exhausted",
        "No available non-conflicting destination name",
    ))
}

pub(super) fn canonical_key(path: &Path) -> OpResult<String> {
    let canonical = destination_dir(path)?;
    let value = canonical.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        let value = value
            .strip_prefix(r"\\?\UNC\")
            .map(|p| format!(r"\\{p}"))
            .unwrap_or_else(|| value.strip_prefix(r"\\?\").unwrap_or(&value).to_string());
        return Ok(value.replace('\\', "/").to_lowercase());
    }
    #[cfg(not(windows))]
    Ok(value)
}

/// Atomic no-replace is essential: a preflight `exists()` check alone can
/// overwrite a file created by another process between the check and rename.
#[cfg(target_os = "linux")]
pub(super) fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub(super) fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(super) fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { winapi::um::winbase::MoveFileW(source.as_ptr(), destination.as_ptr()) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

pub(super) fn same_volume(source: &Path, destination: &Path) -> OpResult<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let a = fs::symlink_metadata(source).map_err(|e| OpError::io("stat", source, e))?;
        let b = fs::metadata(destination).map_err(|e| OpError::io("stat", destination, e))?;
        Ok(a.dev() == b.dev())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        fn volume(path: &Path) -> OpResult<Vec<u16>> {
            let path_utf16: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut volume = vec![0u16; 32_768];
            if unsafe {
                winapi::um::fileapi::GetVolumePathNameW(
                    path_utf16.as_ptr(),
                    volume.as_mut_ptr(),
                    volume.len() as u32,
                )
            } == 0
            {
                return Err(OpError::io(
                    "resolve volume",
                    path,
                    std::io::Error::last_os_error(),
                ));
            }
            volume.truncate(volume.iter().position(|c| *c == 0).unwrap_or(volume.len()));
            Ok(volume)
        }
        Ok(volume(source)? == volume(destination)?)
    }
}
