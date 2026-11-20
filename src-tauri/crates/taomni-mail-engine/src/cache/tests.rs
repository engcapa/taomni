use super::*;

#[test]
fn migration_is_idempotent_and_keeps_rows() {
    let conn = Connection::open_in_memory().unwrap();
    // A pre-watermark schema with a saved message, before any application
    // has initialized the mailbox engine.
    conn.execute_batch("CREATE TABLE mail_messages (
        account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
        message_id TEXT, subject TEXT NOT NULL DEFAULT '', from_name TEXT, from_addr TEXT,
        to_json TEXT DEFAULT '[]', cc_json TEXT DEFAULT '[]', date_ts INTEGER,
        flags_json TEXT NOT NULL DEFAULT '[]', has_attachments INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0, attachments_json TEXT NOT NULL DEFAULT '[]',
        snippet TEXT, raw_size INTEGER, body_text TEXT, body_html TEXT, body_cached_at INTEGER,
        updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, folder, uid)
    );
    INSERT INTO mail_messages(account_id, folder, uid, subject, body_text, body_cached_at, updated_at)
    VALUES ('legacy', 'INBOX', 5, 'Retained', 'Saved body', 1, 1);").unwrap();
    init_mail_tables(&conn).unwrap();
    init_mail_tables(&conn).unwrap();

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, MAIL_SCHEMA_VERSION);
    assert_eq!(
        list_cached_messages(&conn, "legacy", "INBOX", 10, 0).unwrap()[0].subject,
        "Retained"
    );
    assert_eq!(
        get_cached_body(&conn, "legacy", "INBOX", 5)
            .unwrap()
            .unwrap()
            .text
            .as_deref(),
        Some("Saved body")
    );
}
