//! The compiled owner chooses its only store path after the SDK has acquired
//! profile/data leases. Neither renderer inputs nor a manifest choose it.
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use taomni_plugin_api::{ErrorCode, RpcError};

fn failed() -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "MFA_STORE_UNAVAILABLE")
}

fn linked(metadata: &fs::Metadata) -> bool {
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

fn ordinary_file(path: &Path) -> Result<(), RpcError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| failed())?;
    if !metadata.is_file() || linked(&metadata) {
        return Err(failed());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(failed());
        }
    }
    Ok(())
}

/// None is a genuinely unused store. Reject linked parents and SQLite
/// sidecars before opening; never traverse a data-directory link.
pub(super) fn database(profile: &Path, create: bool) -> Result<Option<PathBuf>, RpcError> {
    let mut path = profile.to_path_buf();
    if fs::canonicalize(profile).map_err(|_| failed())? != profile {
        return Err(failed());
    }
    for component in ["plugins", "mfa", "data"] {
        path.push(component);
        if create {
            match fs::create_dir(&path) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err(failed()),
            }
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !linked(&metadata) => (),
            Err(error) if !create && error.kind() == io::ErrorKind::NotFound => return Ok(None),
            _ => return Err(failed()),
        }
    }
    let db = path.join("mfa.db");
    let exists = match fs::symlink_metadata(&db) {
        Ok(_) => {
            ordinary_file(&db)?;
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        _ => return Err(failed()),
    };
    for name in ["mfa.db-wal", "mfa.db-shm", "mfa.db-journal"] {
        let sidecar = path.join(name);
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => ordinary_file(&sidecar)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            _ => return Err(failed()),
        }
    }
    Ok((create || exists).then_some(db))
}
