use rusqlite::{Connection, Result as SqlResult};

pub fn init_cache_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_folders (
            account_id TEXT NOT NULL,
            name TEXT NOT NULL,
            delimiter TEXT,
            flags_json TEXT NOT NULL DEFAULT '[]',
            uid_validity INTEGER,
            uid_next INTEGER,
            total INTEGER,
            unread INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, name)
        );

        CREATE TABLE IF NOT EXISTS mail_messages (
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            uid INTEGER NOT NULL,
            message_id TEXT,
            subject TEXT NOT NULL DEFAULT '',
            from_name TEXT,
            from_addr TEXT,
            to_json TEXT NOT NULL DEFAULT '[]',
            cc_json TEXT NOT NULL DEFAULT '[]',
            date_ts INTEGER,
            flags_json TEXT NOT NULL DEFAULT '[]',
            has_attachments INTEGER NOT NULL DEFAULT 0,
            attachment_count INTEGER NOT NULL DEFAULT 0,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            snippet TEXT,
            body_text TEXT,
            body_html TEXT,
            body_cached_at INTEGER,
            raw_size INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, folder, uid)
        );

        CREATE INDEX IF NOT EXISTS idx_mail_messages_folder_date
            ON mail_messages(account_id, folder, date_ts DESC, uid DESC);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_message_id
            ON mail_messages(account_id, message_id);

        CREATE TABLE IF NOT EXISTS mail_contacts (
            account_id TEXT NOT NULL,
            email TEXT NOT NULL COLLATE NOCASE,
            name TEXT,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0,
            sent_count INTEGER NOT NULL DEFAULT 0,
            received_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, email)
        );

        CREATE INDEX IF NOT EXISTS idx_mail_contacts_search
            ON mail_contacts(account_id, email, name);

        CREATE TABLE IF NOT EXISTS mail_drafts (
            account_id TEXT NOT NULL,
            id TEXT NOT NULL,
            to_json TEXT NOT NULL DEFAULT '[]',
            cc_json TEXT NOT NULL DEFAULT '[]',
            bcc_json TEXT NOT NULL DEFAULT '[]',
            subject TEXT NOT NULL DEFAULT '',
            text_body TEXT NOT NULL DEFAULT '',
            html_body TEXT NOT NULL DEFAULT '',
            attachments_json TEXT NOT NULL DEFAULT '[]',
            reply_context_json TEXT,
            remote_draft_folder TEXT,
            remote_draft_uid INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, id)
        );

        CREATE INDEX IF NOT EXISTS idx_mail_drafts_updated
            ON mail_drafts(account_id, updated_at DESC);",
    )?;
    migrate_mail_tables(conn)
}

pub const MAIL_SCHEMA_VERSION: i64 = 7;

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
        migrate_search_index(conn)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {MAIL_SCHEMA_VERSION};"))
}

fn add_column_if_missing(
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

/// Content columns of the index. Kept in one place for the triggers.
const FTS_SELECT: &str = "COALESCE(subject, ''),
    COALESCE(from_name, '') || ' ' || COALESCE(from_addr, ''),
    COALESCE(to_json, '') || ' ' || COALESCE(cc_json, ''),
    COALESCE(snippet, '') || ' ' || COALESCE(body_text, '')";

/// Create the FTS table, its sync triggers and index existing rows.
fn migrate_search_index(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS mail_messages_fts USING fts5(
            subject, sender, recipients, body,
            tokenize = 'trigram case_sensitive 0'
         );
         CREATE TRIGGER IF NOT EXISTS mail_messages_fts_ai AFTER INSERT ON mail_messages BEGIN
            INSERT INTO mail_messages_fts(rowid, subject, sender, recipients, body)
            SELECT new.rowid, {new_cols};
         END;
         CREATE TRIGGER IF NOT EXISTS mail_messages_fts_ad AFTER DELETE ON mail_messages BEGIN
            DELETE FROM mail_messages_fts WHERE rowid = old.rowid;
         END;
         CREATE TRIGGER IF NOT EXISTS mail_messages_fts_au AFTER UPDATE OF
            subject, from_name, from_addr, to_json, cc_json, snippet, body_text ON mail_messages BEGIN
            DELETE FROM mail_messages_fts WHERE rowid = old.rowid;
            INSERT INTO mail_messages_fts(rowid, subject, sender, recipients, body)
            SELECT new.rowid, {new_cols};
         END;
         DELETE FROM mail_messages_fts;
         INSERT INTO mail_messages_fts(rowid, subject, sender, recipients, body)
            SELECT rowid, {FTS_SELECT} FROM mail_messages;",
        new_cols = FTS_SELECT
            .replace("subject", "new.subject")
            .replace("from_name", "new.from_name")
            .replace("from_addr", "new.from_addr")
            .replace("to_json", "new.to_json")
            .replace("cc_json", "new.cc_json")
            .replace("snippet", "new.snippet")
            .replace("body_text", "new.body_text"),
    ))
}

pub fn migrate_contact_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_cards (
            account_id TEXT NOT NULL,
            uid TEXT NOT NULL,
            book TEXT NOT NULL,
            href TEXT,
            etag TEXT,
            card_json TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            emails TEXT NOT NULL DEFAULT '',
            dirty INTEGER NOT NULL DEFAULT 0,
            deleted INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_mail_cards_href ON mail_cards(account_id, href);
        CREATE TABLE IF NOT EXISTS mail_carddav_state (
            account_id TEXT PRIMARY KEY,
            collection_url TEXT,
            base_url TEXT,
            last_sync INTEGER,
            last_error TEXT
        );",
    )
}

pub fn migrate_calendar_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_calendar_events (
            account_id TEXT NOT NULL,
            href TEXT NOT NULL,
            instance TEXT NOT NULL DEFAULT '',
            event_json TEXT NOT NULL,
            start_ts INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, href, instance)
        );
        CREATE TABLE IF NOT EXISTS mail_caldav_state (
            account_id TEXT PRIMARY KEY,
            base_url TEXT,
            collection_url TEXT,
            last_sync INTEGER,
            last_error TEXT
        );",
    )
}
