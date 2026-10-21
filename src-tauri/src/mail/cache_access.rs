use super::*;

pub fn init_mail_tables(conn: &Connection) -> SqlResult<()> {
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
    sync::migrate_mail_tables(conn)?;
    storage::init_tables(conn)?;
    pop3::migrate_local_tables(conn)?;
    filters::migrate_filter_tables(conn)?;
    contacts::migrate_contact_tables(conn)?;
    caldav::migrate_calendar_tables(conn)
}

pub(super) fn with_mail_db<T>(
    state: &State<'_, AppState>,
    account_id: &str,
    f: impl FnOnce(&Connection) -> SqlResult<T>,
) -> Result<T, String> {
    let db = state.mail_db(account_id)?;
    let db = db.lock().map_err(|e| e.to_string())?;
    f(&db).map_err(|e| e.to_string())
}

/// SQLite and its mutex must not occupy Tokio's workers, which also carry
/// terminal I/O and proxy forwarding. The closure owns only this operation's
/// inputs; the cache lock is never held across a network request.
pub(super) async fn with_mail_db_async<T: Send + 'static>(
    state: &State<'_, AppState>,
    account_id: &str,
    f: impl FnOnce(&Connection, &str) -> SqlResult<T> + Send + 'static,
) -> Result<T, String> {
    let db = state.mail_db(account_id)?;
    mail_db_task(db, account_id.to_string(), f).await
}

/// Locate/open an immutable original under the DB lock, but perform all file
/// work and MIME decoding after releasing it on the blocking pool.
pub(super) async fn with_mail_original<T: Send + 'static>(
    state: &State<'_, AppState>,
    account_id: &str,
    locate: impl FnOnce(&Connection, &str) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    with_mail_db_async(state, account_id, move |db, account| {
        locate(db, account).map_err(storage::as_sql_error)
    })
    .await
}

pub(super) async fn decode_mail_original<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("Saved email task failed: {e}"))?
}

pub(super) async fn mail_db_task<T: Send + 'static>(
    db: crate::state::MailDbHandle,
    account_id: String,
    f: impl FnOnce(&Connection, &str) -> SqlResult<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || {
        let db = db.lock().map_err(|e| e.to_string())?;
        f(&db, &account_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("mail cache task failed: {e}"))?
}
