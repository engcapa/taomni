use russh_sftp::protocol::FileAttributes;
use std::path::Path;

pub(super) fn apply_file_attributes(path: &Path, attrs: &FileAttributes) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(mode) = attrs.permissions {
        use std::os::unix::fs::PermissionsExt;
        // SFTP mode bits include type bits in the high nibble; keep permission bits.
        let mode = mode & 0o7777;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| format!("chmod: {e}"))?;
    }
    #[cfg(not(unix))]
    if let Some(mode) = attrs.permissions {
        // Windows: map owner-write bit to readonly flag only.
        let readonly = (mode & 0o200) == 0;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("stat: {e}"))?
            .permissions();
        perms.set_readonly(readonly);
        std::fs::set_permissions(path, perms).map_err(|e| format!("set_readonly: {e}"))?;
    }

    let atime = attrs
        .atime
        .map(|t| std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::from(t)));
    let mtime = attrs
        .mtime
        .map(|t| std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::from(t)));
    if atime.is_some() || mtime.is_some() {
        let meta = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
        let accessed = atime
            .or_else(|| meta.accessed().ok())
            .unwrap_or(std::time::SystemTime::now());
        let modified = mtime
            .or_else(|| meta.modified().ok())
            .unwrap_or(std::time::SystemTime::now());
        filetime_set(path, accessed, modified)?;
    }
    Ok(())
}

pub(super) fn apply_file_attributes_on_file(
    file: &std::fs::File,
    attrs: &FileAttributes,
) -> Result<(), String> {
    // Best-effort: re-resolve via no path; only times via filetime if we can get
    // a path is not always possible. Apply mode on Unix via the file's metadata path
    // is unavailable — accept times via set_times if supported.
    #[cfg(unix)]
    if let Some(mode) = attrs.permissions {
        use std::os::unix::fs::PermissionsExt;
        let mode = mode & 0o7777;
        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|e| format!("fchmod: {e}"))?;
    }
    let _ = (file, attrs);
    Ok(())
}

pub(super) fn filetime_set(
    path: &Path,
    accessed: std::time::SystemTime,
    modified: std::time::SystemTime,
) -> Result<(), String> {
    // Use filetime crate if present; otherwise std only has limited support.
    // Prefer portable approach via `std::fs::File` + `set_times` (Rust 1.75+).
    use std::fs::File;
    use std::io::ErrorKind;
    let file = File::options()
        .write(true)
        .open(path)
        .map_err(|e| format!("open for utimes: {e}"))?;
    let at = std::fs::FileTimes::new()
        .set_accessed(accessed)
        .set_modified(modified);
    match file.set_times(at) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::Unsupported => Ok(()),
        Err(e) => Err(format!("set_times: {e}")),
    }
}
