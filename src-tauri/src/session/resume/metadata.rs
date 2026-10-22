use super::model::METADATA_REVISION;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS welcome_run_snapshot (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            schema_version INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            run_sequence INTEGER NOT NULL,
            batch_id TEXT NOT NULL,
            committed_at_ms INTEGER NOT NULL,
            entries_json TEXT NOT NULL,
            active_identity TEXT
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

pub(super) fn current_revision(conn: &Connection) -> i64 {
    metadata_get(conn, METADATA_REVISION)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}
