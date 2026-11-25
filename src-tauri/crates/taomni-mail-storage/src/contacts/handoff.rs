//! Adopt legacy address cards exactly once, including unsent CardDAV edits,
//! remote deletion tombstones and the last discovered collection.
use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};

use super::mailbox::{DavState, load_state, save_state};

#[derive(Default, Serialize, Deserialize)]
pub struct AddressBookImport {
    pub replace_staged: bool,
    pub snapshot: BookSnapshot,
}

#[derive(Default, Serialize, Deserialize)]
pub struct BookSnapshot {
    cards: Vec<CardRow>,
    state: Option<DavState>,
}

#[derive(Serialize, Deserialize)]
struct CardRow {
    uid: String,
    book: String,
    href: Option<String>,
    etag: Option<String>,
    card_json: String,
    display_name: String,
    emails: String,
    dirty: i64,
    deleted: i64,
    updated_at: i64,
}

fn has_table(db: &Connection, name: &str) -> Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
}

pub fn read_account(db: &Connection, account: &str) -> Result<BookSnapshot> {
    let cards = if has_table(db, "mail_cards")? {
        db.prepare(
            "SELECT uid,book,href,etag,card_json,display_name,emails,dirty,deleted,updated_at
                    FROM mail_cards WHERE account_id=?1 ORDER BY uid",
        )?
        .query_map([account], |r| {
            Ok(CardRow {
                uid: r.get(0)?,
                book: r.get(1)?,
                href: r.get(2)?,
                etag: r.get(3)?,
                card_json: r.get(4)?,
                display_name: r.get(5)?,
                emails: r.get(6)?,
                dirty: r.get(7)?,
                deleted: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    let state = if has_table(db, "mail_carddav_state")? {
        load_state(db, account)?
    } else {
        None
    };
    Ok(BookSnapshot { cards, state })
}

pub fn is_owned(db: &Connection, account: &str) -> Result<bool> {
    if !has_table(db, "mail_address_book_owners")? {
        return Ok(false);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_address_book_owners WHERE account_id=?1)",
        [account],
        |row| row.get(0),
    )
}

pub fn mark_owned(db: &Connection, account: &str) -> Result<()> {
    db.execute(
        "CREATE TABLE IF NOT EXISTS mail_address_book_owners(account_id TEXT PRIMARY KEY NOT NULL)",
        [],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO mail_address_book_owners(account_id) VALUES (?1)",
        [account],
    )?;
    Ok(())
}

/// Called inside the host's immediate writer transaction. A restored module
/// mailbox can claim its existing rows without inspecting the old profile.
pub fn adopt(db: &Connection, account: &str, source: AddressBookImport) -> Result<()> {
    if is_owned(db, account)? {
        return Ok(());
    }
    if source.replace_staged {
        db.execute("DELETE FROM mail_cards WHERE account_id=?1", [account])?;
        db.execute(
            "DELETE FROM mail_carddav_state WHERE account_id=?1",
            [account],
        )?;
    }
    let mut insert = db.prepare("INSERT INTO mail_cards
        (account_id,uid,book,href,etag,card_json,display_name,emails,dirty,deleted,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
        ON CONFLICT(account_id,uid) DO UPDATE SET book=excluded.book,href=excluded.href,
        etag=excluded.etag,card_json=excluded.card_json,display_name=excluded.display_name,
        emails=excluded.emails,dirty=excluded.dirty,deleted=excluded.deleted,updated_at=excluded.updated_at
        WHERE excluded.updated_at>=mail_cards.updated_at")?;
    for c in source.snapshot.cards {
        insert.execute(params![
            account,
            c.uid,
            c.book,
            c.href,
            c.etag,
            c.card_json,
            c.display_name,
            c.emails,
            c.dirty,
            c.deleted,
            c.updated_at
        ])?;
    }
    if let Some(state) = source.snapshot.state {
        if load_state(db, account)?.and_then(|s| s.last_sync) <= state.last_sync {
            save_state(db, account, state)?;
        }
    }
    mark_owned(db, account)
}
