//! POP3 retrieval and durable local inbox updates.

use std::collections::HashMap;

use rusqlite::{Connection, Transaction, TransactionBehavior, params};

use super::local_store;
use crate::{MailMessageCached, now_ts};

/// Messages fetched per sync call. The consumer repeats while mail remains.
const FETCH_BATCH: usize = 50;

pub trait Pop3Mailbox {
    fn uidl(&mut self) -> Result<Vec<(u32, String)>, String>;
    fn retr(&mut self, number: u32) -> Result<Vec<u8>, String>;
    fn dele(&mut self, number: u32) -> Result<(), String>;
}

pub struct Pop3SyncOutcome {
    pub messages: Vec<MailMessageCached>,
    pub remaining: usize,
    pub deleted_on_server: usize,
}

pub fn sync_inbox(
    client: &mut dyn Pop3Mailbox,
    conn: &Connection,
    account_id: &str,
    leave_days: Option<u32>,
) -> Result<Pop3SyncOutcome, String> {
    local_store::ensure_local_folders(conn, account_id).map_err(database_error)?;
    let listing = client.uidl()?;
    let known = known_messages(conn, account_id).map_err(database_error)?;
    let now = now_ts();
    let (fetch, mut deletes) = plan_round(&listing, &known, FETCH_BATCH, leave_days, now);
    let downloaded = (|| {
        let mut messages = Vec::new();
        for (number, uidl) in &fetch {
            let raw = client.retr(*number)?;
            if let Some(message) =
                commit_download(conn, account_id, uidl, now, &raw).map_err(database_error)?
            {
                messages.push(message);
            }
            if leave_days == Some(0) {
                deletes.push(*number);
            }
        }
        Ok::<_, String>(messages)
    })();
    // Earlier messages may be committed even when a later RETR fails.
    let refreshed = local_store::refresh_counts(conn, account_id, "INBOX");
    let messages = downloaded?;
    refreshed.map_err(database_error)?;
    for number in &deletes {
        client.dele(*number)?;
    }
    for (number, uidl) in &listing {
        if deletes.contains(number) {
            conn.execute(
                "UPDATE mail_pop3_uidl SET deleted = 1 WHERE account_id = ?1 AND uidl = ?2",
                params![account_id, uidl],
            )
            .map_err(database_error)?;
        }
    }
    let remaining = listing
        .iter()
        .filter(|(_, uidl)| !known.contains_key(uidl))
        .count()
        .saturating_sub(fetch.len());
    Ok(Pop3SyncOutcome {
        messages,
        remaining,
        deleted_on_server: deletes.len(),
    })
}

/// Plan one sync round from the server listing and the remembered UIDLs.
/// Returns (numbers to download, numbers to delete on the server).
pub fn plan_round(
    listing: &[(u32, String)],
    known: &HashMap<String, i64>,
    limit: usize,
    leave_days: Option<u32>,
    now: i64,
) -> (Vec<(u32, String)>, Vec<u32>) {
    let fetch: Vec<(u32, String)> = listing
        .iter()
        .filter(|(_, id)| !known.contains_key(id))
        .take(limit)
        .cloned()
        .collect();
    let deletes = match leave_days {
        None => Vec::new(),
        Some(days) => {
            let cutoff = now - i64::from(days) * 86_400;
            listing
                .iter()
                .filter(|(_, id)| known.get(id).is_some_and(|fetched| *fetched <= cutoff))
                .map(|(number, _)| *number)
                .collect()
        }
    };
    (fetch, deletes)
}

fn known_messages(conn: &Connection, account_id: &str) -> rusqlite::Result<HashMap<String, i64>> {
    let mut query =
        conn.prepare("SELECT uidl, fetched_at FROM mail_pop3_uidl WHERE account_id = ?1")?;
    query
        .query_map([account_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

fn commit_download(
    conn: &Connection,
    account_id: &str,
    uidl: &str,
    now: i64,
    raw: &[u8],
) -> rusqlite::Result<Option<MailMessageCached>> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let inserted = tx.execute(
        "INSERT INTO mail_pop3_uidl (account_id, uidl, fetched_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(account_id, uidl) DO NOTHING",
        params![account_id, uidl, now],
    )?;
    if inserted == 0 {
        return Ok(None);
    }
    let message = local_store::insert_local(&tx, account_id, "INBOX", raw, &[])?;
    tx.commit()?;
    Ok(Some(message))
}

fn database_error(error: rusqlite::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_new_downloads_and_expired_deletes() {
        let listing = vec![
            (1, "a".to_string()),
            (2, "b".to_string()),
            (3, "c".to_string()),
        ];
        let known: HashMap<String, i64> =
            [("a".to_string(), 0), ("b".to_string(), 1_000_000)].into();
        let (fetch, deletes) = plan_round(&listing, &known, 10, Some(7), 1_000_000);
        assert_eq!(fetch, vec![(3, "c".to_string())]);
        assert_eq!(
            deletes,
            vec![1],
            "only mail downloaded more than 7 days ago"
        );
        let (_, keep) = plan_round(&listing, &known, 10, None, 1_000_000);
        assert!(keep.is_empty(), "no policy keeps everything on the server");
    }

    #[test]
    fn download_rolls_back_original_header_and_receipt_together() {
        let conn = Connection::open_in_memory().unwrap();
        crate::cache::init_mail_tables(&conn).unwrap();
        local_store::ensure_local_folders(&conn, "pop").unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_original BEFORE INSERT ON mail_local_raw
             BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
        )
        .unwrap();
        let raw = b"From: sender@example.test\r\nSubject: Retried message\r\n\r\nBody";
        assert!(commit_download(&conn, "pop", "uidl-1", 100, raw).is_err());
        assert!(known_messages(&conn, "pop").unwrap().is_empty());
        let headers: i64 = conn
            .query_row("SELECT COUNT(*) FROM mail_messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(headers, 0);

        conn.execute_batch("DROP TRIGGER reject_original").unwrap();
        let header = commit_download(&conn, "pop", "uidl-1", 101, raw)
            .unwrap()
            .unwrap()
            .header;
        assert_eq!(header.subject, "Retried message");
        assert!(
            commit_download(&conn, "pop", "uidl-1", 102, raw)
                .unwrap()
                .is_none()
        );
        assert_eq!(known_messages(&conn, "pop").unwrap()["uidl-1"], 101);
        assert_eq!(
            local_store::read_local_raw(&conn, "pop", "INBOX", header.uid)
                .unwrap()
                .unwrap(),
            raw
        );
    }
}
