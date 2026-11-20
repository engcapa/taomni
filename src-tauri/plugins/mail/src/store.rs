use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, TransactionBehavior};
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

    pub(super) fn mutate<T: Default>(
        &self,
        account_id: &str,
        create: bool,
        check: &dyn Fn() -> Result<(), RpcError>,
        change: impl FnOnce(&Connection) -> Result<T, RpcError>,
    ) -> Result<T, RpcError> {
        validate_account(account_id)?;
        check()?;
        let Some(root) = self.data_root(create)? else {
            return if create {
                Err(unavailable())
            } else {
                Ok(T::default())
            };
        };
        let path = database_for(&root, account_id);
        if regular(&path)? {
            let mut db = connect(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
            return apply_change(&mut db, check, change);
        }
        check_missing_sidecars(&path)?;
        if !create {
            return Ok(T::default());
        }
        // Partially initialized files stay outside the signed backup paths.
        let module = root.parent().ok_or_else(unavailable)?;
        let temporary = tempfile::NamedTempFile::new_in(module).map_err(|_| unavailable())?;
        let mut db = connect(temporary.path(), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        taomni_mail_engine::cache::init_mail_tables(&db).map_err(|_| unavailable())?;
        let changed = apply_change(&mut db, check, change)?;
        db.close().map_err(|_| unavailable())?;
        temporary.as_file().sync_all().map_err(|_| unavailable())?;
        check()?;
        temporary
            .persist_noclobber(path)
            .map_err(|_| unavailable())?;
        Ok(changed)
    }

    fn database_path(&self, account_id: &str) -> Result<Option<PathBuf>, RpcError> {
        validate_account(account_id)?;
        let Some(root) = self.data_root(false)? else {
            return Ok(None);
        };
        let path = database_for(&root, account_id);
        if !regular(&path)? {
            check_missing_sidecars(&path)?;
            return Ok(None);
        }
        Ok(Some(path))
    }

    fn data_root(&self, create: bool) -> Result<Option<PathBuf>, RpcError> {
        let mut root = self.profile.clone();
        for component in ["plugins", "mail", "data"] {
            root.push(component);
            if create {
                match fs::create_dir(&root) {
                    Ok(()) => (),
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
                    Err(_) => return Err(unavailable()),
                }
            }
            if !directory(&root)? {
                return Ok(None);
            }
        }
        Ok(Some(root))
    }

    pub(super) fn snapshot_source(&self, relative: &str) -> Result<PathBuf, RpcError> {
        let path = SafeRelativePath::parse(relative)
            .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
        let root = self.data_root(false)?.ok_or_else(unavailable)?;
        checked_data_file(root, Path::new(path.as_str()))
    }

    pub(super) fn open_owned_file(&self, path: &Path) -> Result<File, RpcError> {
        let root = self.data_root(false)?.ok_or_else(unavailable)?;
        let relative = path.strip_prefix(&root).map_err(|_| unavailable())?;
        let source = checked_data_file(root, relative)?;
        open_snapshot_file(&source)
    }
}

fn checked_data_file(mut root: PathBuf, relative: &Path) -> Result<PathBuf, RpcError> {
    let parent = relative.parent().ok_or_else(unavailable)?;
    for component in parent.components() {
        let Component::Normal(part) = component else {
            return Err(unavailable());
        };
        root.push(part);
        if !directory(&root)? {
            return Err(unavailable());
        }
    }
    root.push(relative.file_name().ok_or_else(unavailable)?);
    if !regular(&root)? {
        return Err(unavailable());
    }
    Ok(root)
}

fn validate_account(account_id: &str) -> Result<(), RpcError> {
    if account_id.trim().is_empty() || account_id.len() > 1024 || account_id.contains('\0') {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    Ok(())
}

fn database_for(root: &Path, account_id: &str) -> PathBuf {
    root.join(format!("{}.db", mail_db_file_stem(account_id)))
}

fn apply_change<T>(
    database: &mut Connection,
    check: &dyn Fn() -> Result<(), RpcError>,
    change: impl FnOnce(&Connection) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
    check()?;
    // Acquire the writer lock before reading a row that will be updated.
    let transaction = database
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| unavailable())?;
    check()?;
    let changed = change(&transaction)?;
    check()?;
    transaction.commit().map_err(|_| unavailable())?;
    Ok(changed)
}

pub(super) fn open_database(path: &Path) -> Result<Connection, RpcError> {
    connect(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

fn connect(path: &Path, mode: OpenFlags) -> Result<Connection, RpcError> {
    for sidecar in sidecars(path) {
        regular(&sidecar)?;
    }
    let db = Connection::open_with_flags(
        path,
        mode | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| unavailable())?;
    db.busy_timeout(Duration::from_secs(3))
        .map_err(|_| unavailable())?;
    db.pragma_update(None, "trusted_schema", false)
        .map_err(|_| unavailable())?;
    Ok(db)
}

fn check_missing_sidecars(path: &Path) -> Result<(), RpcError> {
    for sidecar in sidecars(path) {
        if regular(&sidecar)? {
            return Err(unavailable());
        }
    }
    Ok(())
}

fn sidecars(path: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    ["-wal", "-shm", "-journal"].into_iter().map(|suffix| {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        sidecar.into()
    })
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
