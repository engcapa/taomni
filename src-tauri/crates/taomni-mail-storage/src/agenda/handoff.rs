//! Keep expanded instances and CalDAV discovery metadata together when adopting an account.
use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};

use super::{AgendaState, load_state, save_state};

#[derive(Default, Serialize, Deserialize)]
pub struct AgendaImport {
    pub replace_staged: bool,
    pub snapshot: AgendaSnapshot,
}

#[derive(Default, Serialize, Deserialize)]
pub struct AgendaSnapshot {
    instances: Vec<InstanceRow>,
    state: Option<AgendaState>,
}

#[derive(Serialize, Deserialize)]
struct InstanceRow {
    href: String,
    instance: String,
    event_json: String,
    start_ts: Option<i64>,
    updated_at: i64,
}

fn has_table(db: &Connection, name: &str) -> Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )
}

pub fn read_account(db: &Connection, account: &str) -> Result<AgendaSnapshot> {
    let instances = if has_table(db, "mail_calendar_events")? {
        db.prepare(
            "SELECT href,instance,event_json,start_ts,updated_at FROM mail_calendar_events
             WHERE account_id=?1 ORDER BY href,instance",
        )?
        .query_map([account], |row| {
            Ok(InstanceRow {
                href: row.get(0)?,
                instance: row.get(1)?,
                event_json: row.get(2)?,
                start_ts: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    let state = if has_table(db, "mail_caldav_state")? {
        load_state(db, account)?
    } else {
        None
    };
    Ok(AgendaSnapshot { instances, state })
}

pub fn is_owned(db: &Connection, account: &str) -> Result<bool> {
    if !has_table(db, "mail_agenda_owners")? {
        return Ok(false);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_agenda_owners WHERE account_id=?1)",
        [account],
        |row| row.get(0),
    )
}

pub fn mark_owned(db: &Connection, account: &str) -> Result<()> {
    db.execute(
        "CREATE TABLE IF NOT EXISTS mail_agenda_owners(account_id TEXT PRIMARY KEY NOT NULL)",
        [],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO mail_agenda_owners VALUES (?1)",
        [account],
    )?;
    Ok(())
}

/// The caller supplies the host's writer transaction. A retried import cannot
/// restore old rows over a committed sync or a restored module mailbox.
pub fn adopt(db: &Connection, account: &str, source: AgendaImport) -> Result<()> {
    if is_owned(db, account)? {
        return Ok(());
    }
    if source.replace_staged {
        db.execute(
            "DELETE FROM mail_calendar_events WHERE account_id=?1",
            [account],
        )?;
        db.execute(
            "DELETE FROM mail_caldav_state WHERE account_id=?1",
            [account],
        )?;
    }
    let mut insert = db.prepare(
        "INSERT INTO mail_calendar_events (account_id,href,instance,event_json,start_ts,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(account_id,href,instance) DO UPDATE SET event_json=excluded.event_json,
         start_ts=excluded.start_ts,updated_at=excluded.updated_at
         WHERE excluded.updated_at>=mail_calendar_events.updated_at",
    )?;
    for row in source.snapshot.instances {
        insert.execute(params![
            account,
            row.href,
            row.instance,
            row.event_json,
            row.start_ts,
            row.updated_at
        ])?;
    }
    if let Some(state) = source.snapshot.state {
        if load_state(db, account)?.and_then(|entry| entry.last_sync) <= state.last_sync {
            save_state(db, account, &state)?;
        }
    }
    mark_owned(db, account)
}
