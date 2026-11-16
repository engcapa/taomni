//! Transitional core connection owner and backup adapter for the MFA engine.
//! The signed MFA host replaces this owner in TASK-025-H; it is still legacy.
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub use taomni_mfa_engine::store::*;

pub struct MfaStore {
    path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl MfaStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            conn: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Run `f` on the connection, opening and migrating `mfa.db` on first use.
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
        let guard = context.lock(&self.conn)?;
        if let Some(conn) = guard.as_ref() {
            context.snapshot_connection(conn, dest)?;
            Ok(true)
        } else {
            // Backup must not open/migrate a business store or create an
            // unused database/key. Read-only backup includes committed WAL.
            context.snapshot_existing(&self.path, dest)
        }
    }
}
