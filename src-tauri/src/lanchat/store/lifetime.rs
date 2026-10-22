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
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if dest_path.exists() {
            let _ = std::fs::remove_file(dest_path);
        }
        let dest_str = dest_path.to_str().ok_or("invalid destination path")?;
        conn.execute("VACUUM INTO ?1", rusqlite::params![dest_str])
            .map_err(|e| format!("lanchat backup failed: {e}"))?;
        Ok(())
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
