//! Original mfa.db schema and initialization; no implicit key creation.
use rusqlite::Connection;
use std::path::Path;

pub const SCHEMA_VERSION: i64 = 1;

pub fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create mfa data dir: {e}"))?;
    }
    let conn =
        Connection::open(path).map_err(|e| format!("open mfa database {}: {e}", path.display()))?;
    init_db(&conn).map_err(|e| format!("init mfa database: {e}"))?;
    Ok(conn)
}

pub fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mfa_accounts (
            id TEXT PRIMARY KEY,
            issuer TEXT NOT NULL DEFAULT '',
            account_name TEXT NOT NULL DEFAULT '',
            group_name TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'totp',
            algorithm TEXT NOT NULL DEFAULT 'SHA1',
            digits INTEGER NOT NULL DEFAULT 6,
            period INTEGER NOT NULL DEFAULT 30,
            counter INTEGER NOT NULL DEFAULT 0,
            secret_ct BLOB NOT NULL,
            secret_nonce BLOB NOT NULL,
            fingerprint TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            use_count INTEGER NOT NULL DEFAULT 0,
            last_used_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mfa_accounts_fingerprint ON mfa_accounts(fingerprint);
        CREATE TABLE IF NOT EXISTS mfa_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS mfa_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < SCHEMA_VERSION {
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    }
    Ok(())
}

pub(super) fn sql_err(error: rusqlite::Error) -> String {
    format!("mfa database: {error}")
}
