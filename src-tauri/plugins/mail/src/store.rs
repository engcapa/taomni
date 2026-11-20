use std::{
    fs::{self, Metadata},
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags};
use taomni_mail_engine::database::mail_db_file_stem;
use taomni_plugin_api::{ErrorCode, RpcError};

pub(super) struct Store {
    profile: PathBuf,
}

impl Store {
    pub(super) fn new(profile: &Path) -> Self {
        Self {
            profile: profile.to_owned(),
        }
    }

    pub(super) fn query<T: Default>(
        &self,
        account_id: &str,
        read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, RpcError> {
        let Some(path) = self.database_path(account_id)? else {
            return Ok(T::default());
        };
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| unavailable())?;
        db.busy_timeout(Duration::from_secs(3))
            .map_err(|_| unavailable())?;
        db.pragma_update(None, "trusted_schema", false)
            .map_err(|_| unavailable())?;
        read(&db).map_err(|_| unavailable())
    }

    fn database_path(&self, account_id: &str) -> Result<Option<PathBuf>, RpcError> {
        if account_id.trim().is_empty() || account_id.len() > 1024 || account_id.contains('\0') {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        }
        let mut root = self.profile.clone();
        for component in ["plugins", "mail", "data"] {
            root.push(component);
            match fs::symlink_metadata(&root) {
                Ok(metadata) if metadata.is_dir() && !linked(&metadata) => (),
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                _ => return Err(unavailable()),
            }
        }
        let stem = mail_db_file_stem(account_id);
        let path = root.join(format!("{stem}.db"));
        if !regular(&path)? {
            return Ok(None);
        }
        for suffix in ["wal", "shm", "journal"] {
            regular(&root.join(format!("{stem}.db-{suffix}")))?;
        }
        Ok(Some(path))
    }
}

pub(super) fn unavailable() -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "MAIL_STORE_UNAVAILABLE")
}

fn regular(path: &Path) -> Result<bool, RpcError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(unavailable()),
    };
    if !metadata.is_file() || linked(&metadata) {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(unavailable());
        }
    }
    Ok(true)
}

fn linked(metadata: &Metadata) -> bool {
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
