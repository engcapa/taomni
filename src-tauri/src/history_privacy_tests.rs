use super::*;

fn legacy_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE command_history (
            id INTEGER PRIMARY KEY, host_key TEXT, command TEXT,
            last_used_at INTEGER, use_count INTEGER, UNIQUE(host_key,command));
         INSERT INTO command_history VALUES
           (1,'host','password=alpha',10,2), (2,'host','password=beta',20,3),
           (3,'host','ls -p /tmp',30,4);
         CREATE TABLE sql_history(id TEXT PRIMARY KEY, sql_content TEXT, error TEXT,
           redacted INTEGER NOT NULL DEFAULT 0);
         INSERT INTO sql_history VALUES ('query','select 1','token=confidential',0);",
    )
    .unwrap();
    conn
}

#[test]
fn migration_merges_collisions_preserves_usage_and_is_idempotent() {
    let conn = legacy_db();
    migrate(&conn).unwrap();
    let result = summary(&conn).unwrap();
    assert_eq!(
        result,
        HistoryPrivacySummary {
            version: 1,
            commands_cleaned: 2,
            queries_cleaned: 1
        }
    );
    let merged: (i64, i64, i64) = conn.query_row(
        "SELECT last_used_at,use_count,redacted FROM command_history WHERE command='[REDACTED]'",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(merged, (20, 5, 1));
    let safe: i64 = conn
        .query_row(
            "SELECT use_count FROM command_history WHERE command='ls -p /tmp'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(safe, 4);
    let error: String = conn
        .query_row("SELECT error FROM sql_history", [], |row| row.get(0))
        .unwrap();
    assert_eq!(error, "[REDACTED]");
    migrate(&conn).unwrap();
    assert_eq!(summary(&conn).unwrap(), result);
}

#[test]
fn failed_migration_rolls_back_and_can_retry() {
    let conn = legacy_db();
    // Install a failure at the commit marker to prove all changed rows roll back.
    conn.execute_batch("CREATE TABLE history_privacy_migrations(version INTEGER PRIMARY KEY, commands_cleaned INTEGER, queries_cleaned INTEGER);
        CREATE TRIGGER reject_privacy BEFORE INSERT ON history_privacy_migrations BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert!(migrate(&conn).is_err());
    let count: i64 = conn.query_row("SELECT count(*) FROM command_history WHERE command IN ('password=alpha','password=beta')", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 2);
    conn.execute_batch("DROP TRIGGER reject_privacy").unwrap();
    migrate(&conn).unwrap();
    assert_eq!(summary(&conn).unwrap().commands_cleaned, 2);
}

#[test]
fn persisted_cleanup_remains_clean_after_reopen() {
    let path = std::env::temp_dir().join(format!("taomni-privacy-{}.db", uuid::Uuid::new_v4()));
    {
        let conn = Connection::open(&path).unwrap();
        crate::session::db::init_db(&conn).unwrap();
        conn.execute("INSERT INTO command_history(host_key,command,last_used_at,use_count) VALUES ('x','token=old-secret',1,1)", []).unwrap();
        conn.execute("DELETE FROM history_privacy_migrations", [])
            .unwrap();
        migrate(&conn).unwrap();
    }
    let conn = Connection::open(&path).unwrap();
    crate::session::db::init_db(&conn).unwrap();
    let command: String = conn
        .query_row("SELECT command FROM command_history", [], |row| row.get(0))
        .unwrap();
    assert!(!command.contains("old-secret"));
    assert_eq!(summary(&conn).unwrap().commands_cleaned, 1);
    drop(conn);
    std::fs::remove_file(path).unwrap();
}
