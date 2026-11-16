//! The serial SDK actor owns this lazy connection. No database lock or key is
//! kept between wire requests; snapshot prepare retains only a writer gate.
use rusqlite::{Connection, OpenFlags};
use std::{
    path::PathBuf,
    sync::{
        Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{HostStorage, Operation};

pub(super) struct Store {
    pub(super) profile: PathBuf,
    pub(super) database: Mutex<Option<Connection>>,
    pub(super) frozen: AtomicBool,
}

impl Store {
    pub fn open(storage: &HostStorage) -> Result<Self, RpcError> {
        if storage.context().owner != "mfa" {
            return Err(unavailable());
        }
        let profile = storage.root().path().to_path_buf();
        let database = super::paths::database(&profile, false)?
            .map(|path| open_database(&path, false))
            .transpose()?;
        Ok(Self {
            profile,
            database: Mutex::new(database),
            frozen: AtomicBool::new(false),
        })
    }

    pub fn lock(
        &self,
        operation: &Operation,
    ) -> Result<MutexGuard<'_, Option<Connection>>, RpcError> {
        loop {
            operation.check_current()?;
            match self.database.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(_)) => return Err(unavailable()),
                Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
    }

    pub fn admitted<T>(
        &self,
        operation: &Operation,
        business: impl FnOnce(&mut Connection) -> Result<T, RpcError>,
    ) -> Result<T, RpcError> {
        operation.check_current()?;
        if self.frozen.load(Ordering::Acquire) {
            return Err(snapshot_busy());
        }
        let mut database = self.lock(operation)?;
        if self.frozen.load(Ordering::Acquire) {
            return Err(snapshot_busy());
        }
        if database.is_none() {
            let path = super::paths::database(&self.profile, true)?.ok_or_else(unavailable)?;
            *database = Some(open_database(&path, true)?);
        }
        transaction(
            database.as_mut().ok_or_else(unavailable)?,
            || operation.check_current(),
            business,
        )
    }
}

fn open_database(path: &std::path::Path, create: bool) -> Result<Connection, RpcError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NOFOLLOW
        | if create {
            OpenFlags::SQLITE_OPEN_CREATE
        } else {
            OpenFlags::empty()
        };
    let db = Connection::open_with_flags(path, flags).map_err(|_| unavailable())?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| unavailable())?;
    if version > taomni_mfa_engine::store::SCHEMA_VERSION {
        return Err(unavailable());
    }
    db.busy_timeout(Duration::from_millis(25))
        .map_err(|_| unavailable())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .map_err(|_| unavailable())?;
    taomni_mfa_engine::store::init_db(&db).map_err(|_| unavailable())?;
    Ok(db)
}

/// Engine batches use nested savepoints. The outer actor transaction owns the
/// final commit and rolls back every write on error, timeout, cancellation or
/// unwind, including key_check, HOTP counter, ordering and preferences.
pub(super) fn transaction<T>(
    db: &mut Connection,
    current: impl Fn() -> Result<(), RpcError>,
    business: impl FnOnce(&mut Connection) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
    current()?;
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|_| unavailable())?;
    struct Rollback<'a>(&'a mut Connection);
    impl Drop for Rollback<'_> {
        fn drop(&mut self) {
            let _ = self.0.execute_batch("ROLLBACK");
        }
    }
    let guard = Rollback(db);
    let result = business(guard.0)?;
    current()?;
    guard.0.execute_batch("COMMIT").map_err(|_| unavailable())?;
    Ok(result)
}

pub(super) fn unavailable() -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "MFA_STORE_UNAVAILABLE")
}
pub(super) fn snapshot_busy() -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "PLUGIN_SNAPSHOT_BUSY")
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
