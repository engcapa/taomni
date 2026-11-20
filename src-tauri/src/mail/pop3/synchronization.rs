use super::limits::POP3_FETCH_BATCH;
use super::{ensure_local_folders, insert_local, refresh_counts};
use crate::mail::MailMessageCached;
use crate::mail::now_ts;
use rusqlite::Connection;
use rusqlite::params;
use std::collections::HashMap;
use taomni_mail_engine::pop3::{Pop3Session, plan_round};

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

pub(in crate::mail) struct Pop3SyncOutcome {
    pub messages: Vec<MailMessageCached>,
    pub remaining: usize,
    pub deleted_on_server: usize,
}

/// Download one batch into the local INBOX and apply the leave-on-server policy.
pub(in crate::mail) fn sync_inbox(
    client: &mut Pop3Session,
    conn: &Connection,
    account_id: &str,
    leave_days: Option<u32>,
) -> Result<Pop3SyncOutcome, String> {
    ensure_local_folders(conn, account_id).map_err(|e| e.to_string())?;
    let listing = client.uidl()?;
    let known: HashMap<String, i64> = {
        let mut stmt = conn
            .prepare("SELECT uidl, fetched_at FROM mail_pop3_uidl WHERE account_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    let now = now_ts();
    let (fetch, mut deletes) = plan_round(&listing, &known, POP3_FETCH_BATCH, leave_days, now);
    let mut messages = Vec::new();
    for (number, id) in &fetch {
        let raw = client.retr(*number)?;
        let message =
            insert_local(conn, account_id, "INBOX", &raw, &[]).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO mail_pop3_uidl (account_id, uidl, fetched_at, deleted) VALUES (?1, ?2, ?3, 0)",
            params![account_id, id, now],
        )
        .map_err(|e| e.to_string())?;
        if leave_days == Some(0) {
            deletes.push(*number);
        }
        messages.push(message);
    }
    for number in &deletes {
        client.dele(*number)?;
    }
    if !deletes.is_empty() {
        let deleted_ids: Vec<&String> = listing
            .iter()
            .filter(|(number, _)| deletes.contains(number))
            .map(|(_, id)| id)
            .collect();
        for id in deleted_ids {
            conn.execute(
                "UPDATE mail_pop3_uidl SET deleted = 1 WHERE account_id = ?1 AND uidl = ?2",
                params![account_id, id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    refresh_counts(conn, account_id, "INBOX").map_err(|e| e.to_string())?;
    let remaining = listing
        .iter()
        .filter(|(_, id)| !known.contains_key(id))
        .count()
        .saturating_sub(fetch.len());
    Ok(Pop3SyncOutcome {
        messages,
        remaining,
        deleted_on_server: deletes.len(),
    })
}
