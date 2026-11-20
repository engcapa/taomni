use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags};
use taomni_mail_engine::database::mail_db_file_stem;
use taomni_plugin_api::{ErrorCode, RpcError, services::SafeRelativePath};

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
        read(&open_database(&path)?).map_err(|_| unavailable())
    }

    fn database_path(&self, account_id: &str) -> Result<Option<PathBuf>, RpcError> {
        if account_id.trim().is_empty() || account_id.len() > 1024 || account_id.contains('\0') {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        }
        let Some(root) = self.data_root()? else {
            return Ok(None);
        };
        let stem = mail_db_file_stem(account_id);
        let path = root.join(format!("{stem}.db"));
        if !regular(&path)? {
            return Ok(None);
        }
        Ok(Some(path))
    }

    fn data_root(&self) -> Result<Option<PathBuf>, RpcError> {
        let mut root = self.profile.clone();
        for component in ["plugins", "mail", "data"] {
            root.push(component);
            if !directory(&root)? {
                return Ok(None);
            }
        }
        Ok(Some(root))
    }

    pub(super) fn snapshot_source(&self, relative: &str) -> Result<PathBuf, RpcError> {
        let path = SafeRelativePath::parse(relative)
            .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
        let mut source = self.data_root()?.ok_or_else(unavailable)?;
        let parts: Vec<_> = path.as_str().split('/').collect();
        for part in &parts[..parts.len() - 1] {
            source.push(part);
            if !directory(&source)? {
                return Err(unavailable());
            }
        }
        source.push(parts.last().ok_or_else(unavailable)?);
        if !regular(&source)? {
            return Err(unavailable());
        }
        Ok(source)
    }
}

pub(super) fn open_database(path: &Path) -> Result<Connection, RpcError> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        regular(Path::new(&sidecar))?;
    }
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
    Ok(db)
}

pub(super) fn open_snapshot_file(path: &Path) -> Result<File, RpcError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|_| unavailable())?;
    check_file(&file.metadata().map_err(|_| unavailable())?)?;
    Ok(file)
}

pub(super) fn unavailable() -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "MAIL_STORE_UNAVAILABLE")
}

fn regular(path: &Path) -> Result<bool, RpcError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => check_file(&metadata).map(|()| true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(unavailable()),
    }
}

fn directory(path: &Path) -> Result<bool, RpcError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !linked(&metadata) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        _ => Err(unavailable()),
    }
}

fn check_file(metadata: &Metadata) -> Result<(), RpcError> {
    if !metadata.is_file() || linked(metadata) {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(unavailable());
        }
    }
    Ok(())
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
