//! Account-scoped CalDAV cache and collection discovery state.
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::now_ts;

pub mod handoff;

pub const FUTURE_DAYS: i64 = 60;
pub type AgendaResources = Vec<(String, Vec<MailAgendaEvent>)>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgendaState {
    pub base_url: Option<String>,
    pub collection_url: Option<String>,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventDelta {
    pub resources: AgendaResources,
    pub replace_all: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum AgendaAction {
    ReadState,
    List {
        days: i64,
    },
    Commit {
        state: AgendaState,
        events: Option<EventDelta>,
    },
}

impl AgendaAction {
    pub fn writes(&self) -> bool {
        matches!(self, Self::Commit { .. })
    }

    pub fn execute(self, db: &Connection, account: &str) -> SqlResult<Value> {
        match self {
            Self::ReadState => to_value(load_state(db, account)?),
            Self::List { days } => {
                to_value(agenda(db, account, now_ts(), days.clamp(1, FUTURE_DAYS))?)
            }
            Self::Commit { state, events } => {
                let count = match events {
                    Some(delta) => store_events(db, account, &delta.resources, delta.replace_all)?,
                    None => 0,
                };
                save_state(db, account, &state)?;
                to_value(count)
            }
        }
    }
}

fn to_value(value: impl Serialize) -> SqlResult<Value> {
    serde_json::to_value(value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn load_state(db: &Connection, account: &str) -> SqlResult<Option<AgendaState>> {
    db.query_row(
        "SELECT base_url,collection_url,last_sync,last_error FROM mail_caldav_state WHERE account_id=?1",
        [account],
        |row| Ok(AgendaState {
            base_url: row.get(0)?,
            collection_url: row.get(1)?,
            last_sync: row.get(2)?,
            last_error: row.get(3)?,
        }),
    )
    .optional()
}

fn save_state(db: &Connection, account: &str, state: &AgendaState) -> SqlResult<()> {
    db.execute(
        "INSERT INTO mail_caldav_state (account_id,base_url,collection_url,last_sync,last_error)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(account_id) DO UPDATE SET base_url=excluded.base_url,
         collection_url=excluded.collection_url,last_sync=excluded.last_sync,last_error=excluded.last_error",
        params![account, state.base_url, state.collection_url, state.last_sync, state.last_error],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAgendaEvent {
    pub uid: String,
    pub summary: String,
    pub location: Option<String>,
    /// Epoch seconds when known (UTC and expanded instances).
    pub start: Option<i64>,
    pub end: Option<i64>,
    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` as written.
    pub start_local: String,
    pub tzid: Option<String>,
    pub all_day: bool,
    /// Minutes before the start for the first display/audio alarm.
    pub alarm_minutes: Option<i64>,
    /// Instance id of a recurring event (`RECURRENCE-ID`), else empty.
    #[serde(default)]
    pub instance: String,
}

/// Replace the cached events of the synced resources.
pub fn store_events(
    conn: &Connection,
    account_id: &str,
    resources: &[(String, Vec<MailAgendaEvent>)],
    replace_all: bool,
) -> SqlResult<usize> {
    if replace_all {
        conn.execute(
            "DELETE FROM mail_calendar_events WHERE account_id = ?1",
            params![account_id],
        )?;
    }
    let mut count = 0;
    for (href, events) in resources {
        conn.execute(
            "DELETE FROM mail_calendar_events WHERE account_id = ?1 AND href = ?2",
            params![account_id, href],
        )?;
        for event in events {
            conn.execute(
                "INSERT OR REPLACE INTO mail_calendar_events
                 (account_id, href, instance, event_json, start_ts, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    account_id,
                    href,
                    event.instance,
                    serde_json::to_string(event).map_err(|error| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(error))
                    })?,
                    event.start,
                    now_ts()
                ],
            )?;
            count += 1;
        }
    }
    Ok(count)
}

/// Upcoming events (still running or starting within `days`), soonest first.
pub fn agenda(
    conn: &Connection,
    account_id: &str,
    now: i64,
    days: i64,
) -> SqlResult<Vec<MailAgendaEvent>> {
    let mut stmt =
        conn.prepare("SELECT event_json FROM mail_calendar_events WHERE account_id = ?1")?;
    let rows = stmt.query_map(params![account_id], |row| row.get::<_, String>(0))?;
    let horizon = now + days * 86_400;
    let mut events: Vec<MailAgendaEvent> = Vec::new();
    for json in rows {
        let Ok(event) = serde_json::from_str::<MailAgendaEvent>(&json?) else {
            continue;
        };
        let keep = match (event.start, event.end) {
            (Some(start), end) => start <= horizon && end.unwrap_or(start) >= now,
            // Zoned times without a tz database: keep by date text.
            (None, _) => true,
        };
        if keep {
            events.push(event);
        }
    }
    events.sort_by(|a, b| {
        a.start
            .unwrap_or(i64::MAX)
            .cmp(&b.start.unwrap_or(i64::MAX))
            .then_with(|| a.start_local.cmp(&b.start_local))
    });
    Ok(events)
}
