//! Backup adapter for the original MFA database. The isolated QA build can
//! also open the old store to create and exercise upgrade fixtures.
#[cfg(any(test, feature = "legacy-mfa"))]
use rusqlite::Connection;
use std::path::{Path, PathBuf};
#[cfg(any(test, feature = "legacy-mfa"))]
use std::sync::Mutex;

#[cfg(any(test, feature = "legacy-mfa"))]
pub use taomni_mfa_engine::store::*;

pub struct MfaStore {
    path: PathBuf,
    #[cfg(any(test, feature = "legacy-mfa"))]
    conn: Mutex<Option<Connection>>,
}

impl MfaStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            #[cfg(any(test, feature = "legacy-mfa"))]
            conn: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Run `f` on the connection, opening and migrating `mfa.db` on first use.
    #[cfg(any(test, feature = "legacy-mfa"))]
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.conn.lock().map_err(|e| format!("mfa db lock: {e}"))?;
        if guard.is_none() {
            *guard = Some(open_db(&self.path)?);
        }
        f(guard.as_mut().expect("mfa connection initialised above"))
    }

    /// Consistent snapshot for backups. Returns `false` when MFA was never
    /// used (no file on disk and no open connection), so nothing is staged.
    pub fn backup_to(&self, dest: &Path) -> Result<bool, String> {
        self.backup_to_with_context(
            dest,
            &crate::backup::snapshot_context::SnapshotContext::default(),
        )
    }

    pub(crate) fn backup_to_with_context(
        &self,
        dest: &Path,
        context: &crate::backup::snapshot_context::SnapshotContext,
    ) -> Result<bool, String> {
        #[cfg(any(test, feature = "legacy-mfa"))]
        {
            let guard = context.lock(&self.conn)?;
            if let Some(conn) = guard.as_ref() {
                context.snapshot_connection(conn, dest)?;
                return Ok(true);
            }
        }
        // Read-only backup includes committed WAL and does not create or migrate a store.
        context.snapshot_existing(&self.path, dest)
    }
}
