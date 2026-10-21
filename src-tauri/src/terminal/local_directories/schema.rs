use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

pub const METADATA_DIRECTORY_REVISION: &str = "welcome_directory_revision";
pub const METADATA_MIGRATION_COMPLETE: &str = "directory_migration_v1";
pub(super) const METADATA_MIGRATION_COMPLETE_VALUE: &str = "complete";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS welcome_directory_usage (
            directory_id TEXT PRIMARY KEY,
            display_path TEXT NOT NULL,
            last_used_at_ms INTEGER,
            last_use_source TEXT,
            legacy_rank INTEGER,
            legacy_observed_at_ms INTEGER
        );

        CREATE TABLE IF NOT EXISTS welcome_directory_alias (
            path_key TEXT PRIMARY KEY,
            directory_id TEXT NOT NULL,
            display_path TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_welcome_alias_directory
            ON welcome_directory_alias(directory_id);

        CREATE TABLE IF NOT EXISTS welcome_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
}

pub(super) fn metadata_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM welcome_metadata WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

pub(super) fn metadata_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub(super) fn metadata_increment(conn: &Connection, key: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        params![key],
    )?;
    Ok(metadata_get(conn, key)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1))
}

pub fn directory_revision(conn: &Connection) -> i64 {
    metadata_get(conn, METADATA_DIRECTORY_REVISION)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}
