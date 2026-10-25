use super::schema::init_schema;
use super::schema::migrate_schema;
use crate::vault::crypto;
use rusqlite::Connection;
use rusqlite::params;
use std::path::Path;
use std::sync::Mutex;
use std::sync::OnceLock;
use zeroize::Zeroizing;

/// SQLite-backed LanChat store. Single connection guarded by a mutex.
pub struct LanChatStore {
    pub(super) conn: Mutex<Connection>,
    /// AES-256-GCM key for at-rest message-body encryption, loaded from the OS
    /// keychain (phase 3). When unset (e.g. store unit tests), bodies are stored
    /// in plaintext (`enc_ver = 0`) for backward compatibility.
    pub(super) msg_key: OnceLock<Zeroizing<[u8; crypto::KEY_LEN]>>,
}

impl LanChatStore {
    /// Open (creating if needed) the `lanchat.sqlite` file and ensure schema.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        // WAL keeps reads non-blocking during the frequent message writes.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        init_schema(&conn)?;
        migrate_schema(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
            msg_key: OnceLock::new(),
        })
    }

    /// Perform a consistent SQLite online hot-backup of the lanchat database.
    pub fn backup_to(&self, dest_path: &Path) -> Result<(), String> {
        self.backup_to_with_context(
            dest_path,
            &crate::backup::snapshot_context::SnapshotContext::default(),
        )
    }

    pub(crate) fn backup_to_with_context(
        &self,
        dest_path: &Path,
        context: &crate::backup::snapshot_context::SnapshotContext,
    ) -> Result<(), String> {
        let conn = context.lock(&self.conn)?;
        crate::backup::snapshot_context::hot_backup_conn(&conn, dest_path, context)
    }

    #[cfg(test)]
    pub(super) fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        init_schema(&conn)?;
        migrate_schema(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
            msg_key: OnceLock::new(),
        })
    }
}
