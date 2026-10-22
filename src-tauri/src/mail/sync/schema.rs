use rusqlite::Connection;
use rusqlite::Result as SqlResult;

pub(super) const MAIL_SCHEMA_VERSION: i64 = 7;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/// Idempotent schema upgrade; cheap when already current (called per open).
pub fn migrate_mail_tables(conn: &Connection) -> SqlResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version >= MAIL_SCHEMA_VERSION {
        return Ok(());
    }
    let folder_columns = [
        ("sync_low_uid", "INTEGER"),
        ("sync_high_uid", "INTEGER"),
        ("sync_complete", "INTEGER NOT NULL DEFAULT 0"),
        ("sync_needs_repair", "INTEGER NOT NULL DEFAULT 0"),
        ("highest_modseq", "INTEGER"),
        ("last_reconcile_at", "INTEGER"),
        ("last_error", "TEXT"),
    ];
    for (name, decl) in folder_columns {
        add_column_if_missing(conn, "mail_folders", name, decl)?;
    }
    add_column_if_missing(conn, "mail_messages", "internal_ts", "INTEGER")?;
    // v3: reply threading.
    add_column_if_missing(conn, "mail_messages", "in_reply_to", "TEXT")?;
    add_column_if_missing(
        conn,
        "mail_messages",
        "references_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    // v5: mailing-list unsubscribe (TASK-18).
    add_column_if_missing(conn, "mail_messages", "list_unsubscribe_json", "TEXT")?;
    // v6: when this client last changed the flags (ms), so a reconcile that
    // read the server before our STORE does not undo it.
    add_column_if_missing(conn, "mail_messages", "flags_local_at", "INTEGER")?;
    // v7: read receipt requests (Disposition-Notification-To, TASK-17).
    add_column_if_missing(conn, "mail_messages", "receipt_to", "TEXT")?;
    // v4: local full-text index.
    if version < 4 {
        super::super::search::migrate_search_index(conn)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {MAIL_SCHEMA_VERSION};"))
}

pub(super) fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> SqlResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name.eq_ignore_ascii_case(column));
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}
