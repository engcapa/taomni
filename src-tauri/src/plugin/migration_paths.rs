//! Ordinary, fixed profile locations used by legacy inspection and export.
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io,
    path::{Path, PathBuf},
};

pub(crate) fn directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("legacy migration directory must not be linked".into());
    }
    Ok(())
}

pub(in crate::plugin) fn create_directory(parent: &Path, name: &str) -> Result<PathBuf, String> {
    directory(parent)?;
    let path = parent.join(name);
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    directory(&path)?;
    Ok(path)
}

pub(crate) fn file_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            regular(&metadata)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

/// SQLite may open sidecars without passing through the main-file hash.
pub(crate) fn database_exists(path: &Path) -> Result<bool, String> {
    let exists = file_exists(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        if file_exists(Path::new(&sidecar))? && !exists {
            return Err("legacy migration database is missing with retained sidecars".into());
        }
    }
    Ok(exists)
}

pub(crate) fn read_json_bounded<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    use std::io::Read;
    const MAX_BYTES: u64 = 1024 * 1024;
    let mut data = Vec::new();
    open_file(path)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    if data.len() as u64 > MAX_BYTES {
        return Err("Migration record is too large".into());
    }
    serde_json::from_slice(&data).map_err(|error| error.to_string())
}

pub(in crate::plugin) fn read_detached_signature(path: &Path) -> Result<String, String> {
    use std::io::Read;
    const MAX_BYTES: u64 = 16 * 1024;
    let mut signature = String::new();
    open_file(path)?
        .take(MAX_BYTES + 1)
        .read_to_string(&mut signature)
        .map_err(|error| format!("Could not read detached signature: {error}"))?;
    if signature.len() as u64 > MAX_BYTES {
        return Err("Detached signature is too large".into());
    }
    Ok(signature)
}

pub(crate) fn write_json_durable<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), String> {
    use std::io::Write;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    directory(parent)?;
    file_exists(path)?;
    let mut stage = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    let json = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    stage.write_all(&json).map_err(|error| error.to_string())?;
    stage
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    stage.persist(path).map_err(|error| error.to_string())?;
    sync_directory(parent)
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(crate) fn open_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    regular(&file.metadata().map_err(|error| error.to_string())?)?;
    Ok(file)
}

fn regular(metadata: &Metadata) -> Result<(), String> {
    if !metadata.is_file() || is_link(metadata) {
        return Err("legacy migration input must be an ordinary file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("legacy migration input must not be hard linked".into());
        }
    }
    Ok(())
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
