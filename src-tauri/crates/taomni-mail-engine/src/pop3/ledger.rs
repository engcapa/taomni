//! Account-scoped persistence for downloaded POP3 originals and receipts.

use std::{collections::HashMap, ops::Deref};

use rusqlite::{Connection, Transaction, TransactionBehavior, params};

use super::local_store;
use crate::{MailMessageCached, MailMessageHeader};

pub trait Pop3Ledger {
    fn known_messages(&self) -> Result<HashMap<String, i64>, String>;
    fn save_message(
        &self,
        uidl: &str,
        fetched_at: i64,
        original: &[u8],
    ) -> Result<Option<MailMessageHeader>, String>;
    fn refresh_counts(&self) -> Result<(), String>;
    fn confirm_deletions(&self, uidls: &[&str]) -> Result<(), String>;
}

struct SqliteLedger<'a, F> {
    database: F,
    account: &'a str,
}

pub fn sqlite_ledger<D: Deref<Target = Connection>>(
    database: impl Fn() -> Result<D, String>,
    account: &str,
) -> impl Pop3Ledger {
    SqliteLedger { database, account }
}

impl<D, F> Pop3Ledger for SqliteLedger<'_, F>
where
    D: Deref<Target = Connection>,
    F: Fn() -> Result<D, String>,
{
    fn known_messages(&self) -> Result<HashMap<String, i64>, String> {
        let connection = (self.database)()?;
        local_store::ensure_local_folders(&connection, self.account).map_err(database_error)?;
        known_messages(&connection, self.account).map_err(database_error)
    }

    fn save_message(
        &self,
        uidl: &str,
        fetched_at: i64,
        original: &[u8],
    ) -> Result<Option<MailMessageHeader>, String> {
        let connection = (self.database)()?;
        commit_download(&connection, self.account, uidl, fetched_at, original)
            .map(|message| message.map(|message| message.header))
            .map_err(database_error)
    }

    fn refresh_counts(&self) -> Result<(), String> {
        let connection = (self.database)()?;
        local_store::refresh_counts(&connection, self.account, "INBOX").map_err(database_error)
    }

    fn confirm_deletions(&self, uidls: &[&str]) -> Result<(), String> {
        let connection = (self.database)()?;
        let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)
            .map_err(database_error)?;
        {
            let mut update = tx
                .prepare(
                    "UPDATE mail_pop3_uidl SET deleted = 1 WHERE account_id = ?1 AND uidl = ?2",
                )
                .map_err(database_error)?;
            for uidl in uidls {
                update
                    .execute(params![self.account, uidl])
                    .map_err(database_error)?;
            }
        }
        tx.commit().map_err(database_error)
    }
}

fn known_messages(conn: &Connection, account: &str) -> rusqlite::Result<HashMap<String, i64>> {
    let mut query =
        conn.prepare("SELECT uidl, fetched_at FROM mail_pop3_uidl WHERE account_id = ?1")?;
    query
        .query_map([account], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

fn commit_download(
    conn: &Connection,
    account: &str,
    uidl: &str,
    now: i64,
    raw: &[u8],
) -> rusqlite::Result<Option<MailMessageCached>> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let inserted = tx.execute(
        "INSERT INTO mail_pop3_uidl (account_id, uidl, fetched_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(account_id, uidl) DO NOTHING",
        params![account, uidl, now],
    )?;
    if inserted == 0 {
        return Ok(None);
    }
    let message = local_store::insert_local(&tx, account, "INBOX", raw, &[])?;
    tx.commit()?;
    Ok(Some(message))
}

fn database_error(error: rusqlite::Error) -> String {
    error.to_string()
}
