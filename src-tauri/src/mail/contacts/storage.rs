use super::model::CardChange;
use super::model::StoredCard;
use crate::mail::now_ts;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;

pub(in crate::mail) fn migrate_contact_tables(conn: &Connection) -> SqlResult<()> {
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

pub(super) fn row_to_stored(row: &rusqlite::Row<'_>) -> SqlResult<StoredCard> {
    let json: String = row.get(0)?;
    Ok(StoredCard {
        card: serde_json::from_str(&json).unwrap_or_default(),
        book: row.get(1)?,
        href: row.get(2)?,
        etag: row.get(3)?,
        dirty: row.get::<_, i64>(4)? != 0,
        deleted: row.get::<_, i64>(5)? != 0,
    })
}

pub(super) const CARD_COLUMNS: &str = "card_json, book, href, etag, dirty, deleted";

pub(in crate::mail) fn load_cards(
    conn: &Connection,
    account_id: &str,
) -> SqlResult<Vec<StoredCard>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CARD_COLUMNS} FROM mail_cards WHERE account_id = ?1
         ORDER BY lower(display_name), uid"
    ))?;
    let rows = stmt.query_map(params![account_id], row_to_stored)?;
    rows.collect()
}

pub(super) fn load_card(
    conn: &Connection,
    account_id: &str,
    uid: &str,
) -> SqlResult<Option<StoredCard>> {
    conn.query_row(
        &format!("SELECT {CARD_COLUMNS} FROM mail_cards WHERE account_id = ?1 AND uid = ?2"),
        params![account_id, uid],
        row_to_stored,
    )
    .optional()
}

pub(in crate::mail) fn store_card(
    conn: &Connection,
    account_id: &str,
    stored: &StoredCard,
) -> SqlResult<()> {
    let emails = stored
        .card
        .emails
        .iter()
        .map(|e| e.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    conn.execute(
        "INSERT INTO mail_cards
         (account_id, uid, book, href, etag, card_json, display_name, emails, dirty, deleted, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(account_id, uid) DO UPDATE SET
            book = excluded.book, href = excluded.href, etag = excluded.etag,
            card_json = excluded.card_json, display_name = excluded.display_name,
            emails = excluded.emails, dirty = excluded.dirty, deleted = excluded.deleted,
            updated_at = excluded.updated_at",
        params![
            account_id,
            stored.card.uid,
            stored.book,
            stored.href,
            stored.etag,
            serde_json::to_string(&stored.card).unwrap_or_default(),
            stored.card.display_name,
            emails,
            stored.dirty as i64,
            stored.deleted as i64,
            now_ts()
        ],
    )?;
    Ok(())
}

pub(super) fn remove_card(conn: &Connection, account_id: &str, uid: &str) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM mail_cards WHERE account_id = ?1 AND uid = ?2",
        params![account_id, uid],
    )?;
    Ok(())
}

pub(in crate::mail) fn apply_changes(
    conn: &Connection,
    account_id: &str,
    changes: &[CardChange],
) -> SqlResult<()> {
    for change in changes {
        match change {
            CardChange::Store(stored) => store_card(conn, account_id, stored)?,
            CardChange::Remove(uid) => remove_card(conn, account_id, uid)?,
        }
    }
    Ok(())
}
