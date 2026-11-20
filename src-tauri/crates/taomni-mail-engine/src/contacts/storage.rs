use super::model::CardChange;
use super::model::StoredCard;
use crate::now_ts;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;

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

pub fn load_cards(conn: &Connection, account_id: &str) -> SqlResult<Vec<StoredCard>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CARD_COLUMNS} FROM mail_cards WHERE account_id = ?1
         ORDER BY lower(display_name), uid"
    ))?;
    let rows = stmt.query_map(params![account_id], row_to_stored)?;
    rows.collect()
}

pub(super) fn load_visible_cards_page(
    conn: &Connection,
    account_id: &str,
    limit: u32,
    offset: u32,
) -> SqlResult<Vec<StoredCard>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CARD_COLUMNS} FROM mail_cards WHERE account_id = ?1 AND deleted = 0
         ORDER BY lower(display_name), uid LIMIT ?2 OFFSET ?3"
    ))?;
    let rows = stmt.query_map(params![account_id, limit, offset], row_to_stored)?;
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

pub fn store_card(conn: &Connection, account_id: &str, stored: &StoredCard) -> SqlResult<()> {
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

pub fn apply_changes(conn: &Connection, account_id: &str, changes: &[CardChange]) -> SqlResult<()> {
    for change in changes {
        match change {
            CardChange::Store(stored) => store_card(conn, account_id, stored)?,
            CardChange::Remove(uid) => remove_card(conn, account_id, uid)?,
        }
    }
    Ok(())
}
