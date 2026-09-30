//! CalDAV agenda (TASK-20 phase 2, DEC-14 "minimal"): discover the account's
//! calendar, cache the next weeks of events (recurrences expanded by the
//! server, so instances arrive in UTC), and write accepted invitations into
//! the calendar. No calendar grid; reminders are shown by the open mail tab.

use reqwest::Url;
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::calendar::{param, parse_time, split_property, unescape, unfold};
use super::webdav::{CALDAV, DavAuth, DavClient, XML, href_path, parse_multistatus};
use super::{MailAccountConfig, MailAuthMode, now_ts, resolve_config, with_mail_db};
use crate::state::AppState;

/// CalDAV calendar of a mail account (same shape as the CardDAV settings).
pub type MailCalDavSettings = super::contacts::MailCardDavSettings;

/// Agenda window pulled from the server.
const PAST_DAYS: i64 = 1;
const FUTURE_DAYS: i64 = 60;

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

/// `-PT15M`, `-P1D`, `-PT1H30M` → minutes before the start.
fn trigger_minutes(value: &str) -> Option<i64> {
    let value = value.trim();
    let negative = value.starts_with('-');
    let body = value.trim_start_matches(['-', '+']).strip_prefix('P')?;
    let (date, time) = body.split_once('T').unwrap_or((body, ""));
    let mut minutes = 0i64;
    let mut take = |text: &str, units: &[(char, i64)]| {
        let mut number = String::new();
        for ch in text.chars() {
            if ch.is_ascii_digit() {
                number.push(ch);
            } else if let Some((_, factor)) = units.iter().find(|(unit, _)| *unit == ch) {
                minutes += number.parse::<i64>().unwrap_or(0) * factor;
                number.clear();
            }
        }
    };
    take(date, &[('W', 7 * 24 * 60), ('D', 24 * 60)]);
    take(time, &[('H', 60), ('M', 1), ('S', 0)]);
    // A trigger after the start (positive) is not a reminder before it.
    negative.then_some(minutes).or((minutes == 0).then_some(0))
}

/// Every VEVENT of an iCalendar object (expanded instances included).
pub(super) fn parse_events(ics: &str) -> Vec<MailAgendaEvent> {
    let mut events = Vec::new();
    let mut current: Option<MailAgendaEvent> = None;
    let mut in_alarm = false;
    let mut nested = 0usize;
    for line in unfold(ics) {
        let (name, params, value) = split_property(&line);
        let block = value.trim().to_ascii_uppercase();
        match name.as_str() {
            "BEGIN" if block == "VEVENT" => current = Some(MailAgendaEvent::default()),
            "BEGIN" if block == "VALARM" && current.is_some() => in_alarm = true,
            "BEGIN" if current.is_some() => nested += 1,
            "END" if block == "VALARM" => in_alarm = false,
            "END" if block == "VEVENT" => {
                if let Some(event) = current.take().filter(|e| !e.uid.is_empty()) {
                    events.push(event);
                }
            }
            "END" if nested > 0 => nested -= 1,
            _ => {
                let Some(event) = current.as_mut() else {
                    continue;
                };
                if nested > 0 {
                    continue;
                }
                if in_alarm {
                    if name == "TRIGGER"
                        && param(&params, "VALUE").is_none()
                        && event.alarm_minutes.is_none()
                    {
                        event.alarm_minutes = trigger_minutes(&value);
                    }
                    continue;
                }
                match name.as_str() {
                    "UID" => event.uid = value.trim().to_string(),
                    "SUMMARY" => event.summary = unescape(&value),
                    "LOCATION" => event.location = Some(unescape(&value)).filter(|v| !v.is_empty()),
                    "RECURRENCE-ID" => event.instance = value.trim().to_string(),
                    "DTSTART" => {
                        if let Some(time) = parse_time(&value, &params) {
                            event.start = time.epoch;
                            event.start_local = time.local;
                            event.tzid = time.tzid;
                            event.all_day = time.all_day;
                        }
                    }
                    "DTEND" => event.end = parse_time(&value, &params).and_then(|t| t.epoch),
                    _ => {}
                }
            }
        }
    }
    for event in &mut events {
        if event.end.is_none() {
            event.end = event
                .start
                .map(|s| s + if event.all_day { 86_400 } else { 3_600 });
        }
    }
    events
}

pub(super) fn migrate_calendar_tables(conn: &Connection) -> SqlResult<()> {
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

/// Replace the cached events of the synced resources.
pub(super) fn store_events(
    conn: &Connection,
    account_id: &str,
    resources: &[(String, Vec<MailAgendaEvent>)],
    replace_all: bool,
) -> SqlResult<usize> {
    let tx = conn.unchecked_transaction()?;
    if replace_all {
        tx.execute(
            "DELETE FROM mail_calendar_events WHERE account_id = ?1",
            params![account_id],
        )?;
    }
    let mut count = 0;
    for (href, events) in resources {
        tx.execute(
            "DELETE FROM mail_calendar_events WHERE account_id = ?1 AND href = ?2",
            params![account_id, href],
        )?;
        for event in events {
            tx.execute(
                "INSERT OR REPLACE INTO mail_calendar_events
                 (account_id, href, instance, event_json, start_ts, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    account_id,
                    href,
                    event.instance,
                    serde_json::to_string(event).unwrap_or_default(),
                    event.start,
                    now_ts()
                ],
            )?;
            count += 1;
        }
    }
    tx.commit()?;
    Ok(count)
}

/// Upcoming events (still running or starting within `days`), soonest first.
pub(super) fn agenda(
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

fn stamp(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .unwrap_or_default()
        .format("%Y%m%dT%H%M%SZ")
        .to_string()
}

/// `calendar-query` for VEVENTs in [start, end], expanded to instances.
fn calendar_query(start: i64, end: i64) -> String {
    let (start, end) = (stamp(start), stamp(end));
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="{start}" end="{end}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="{start}" end="{end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#
    )
}

/// An invitation as a CalDAV resource: no METHOD (RFC 4791 §4.1) and, when
/// accepting, my ATTENDEE line carries the new PARTSTAT.
pub(super) fn invite_resource(ics: &str, me: &str, partstat: Option<&str>) -> String {
    let me = me.trim().to_ascii_lowercase();
    let mut out = Vec::new();
    for line in unfold(ics) {
        let (name, _, value) = split_property(&line);
        if name == "METHOD" {
            continue;
        }
        let mine = name == "ATTENDEE"
            && value
                .trim()
                .trim_start_matches("mailto:")
                .trim_start_matches("MAILTO:")
                .eq_ignore_ascii_case(&me);
        match (mine, partstat) {
            (true, Some(partstat)) => {
                let (head, rest) = line.split_once(':').unwrap_or((&line, ""));
                let params: Vec<&str> = head
                    .split(';')
                    .filter(|p| {
                        !p.to_ascii_uppercase().starts_with("PARTSTAT=")
                            && !p.to_ascii_uppercase().starts_with("RSVP=")
                    })
                    .collect();
                out.push(format!("{};PARTSTAT={partstat}:{rest}", params.join(";")));
            }
            _ => out.push(line),
        }
    }
    out.iter()
        .map(|l| super::calendar::fold(l))
        .collect::<Vec<_>>()
        .join("\r\n")
        + "\r\n"
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCalDavSyncResult {
    pub collection: String,
    pub events: usize,
    pub errors: Vec<String>,
}

fn collection_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw.trim()).map_err(|e| format!("invalid CalDAV URL: {e}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("the CalDAV URL must start with https://".into());
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// Pull the agenda window: every event resource with its expanded instances.
async fn pull(
    client: &DavClient,
    collection: &Url,
    now: i64,
) -> Result<Vec<(String, Vec<MailAgendaEvent>)>, String> {
    let body = calendar_query(now - PAST_DAYS * 86_400, now + FUTURE_DAYS * 86_400);
    let reply = client
        .send("REPORT", collection, Some("1"), Some((body, XML)), &[])
        .await?;
    if reply.status != 207 {
        return Err(format!("CalDAV REPORT returned {}", reply.status));
    }
    Ok(parse_multistatus(&reply.body)
        .into_iter()
        .filter_map(|response| {
            let data = response.props.get("calendar-data")?;
            Some((href_path(collection, &response.href), parse_events(data)))
        })
        .collect())
}

struct CalDavTarget {
    client: DavClient,
    collection: Url,
    base: String,
}

async fn open_calendar(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
) -> Result<(CalDavTarget, String), String> {
    let settings = config
        .caldav
        .clone()
        .filter(|c| !c.url.trim().is_empty())
        .ok_or_else(|| "no CalDAV calendar is configured for this account".to_string())?;
    let account_id = config.session_id.clone();
    let account = resolve_config(state, config)?;
    let auth = if account.auth_mode == MailAuthMode::OAuth2 {
        DavAuth::Bearer(account.imap_password.clone())
    } else {
        let user = settings
            .username
            .clone()
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| account.imap_username.clone());
        DavAuth::Basic(user, account.imap_password.clone())
    };
    let client = DavClient::new(CALDAV, auth, false)?;
    let base = settings.url.trim().to_string();
    let cached: Option<(Option<String>, Option<String>)> =
        with_mail_db(state, &account_id, |db| {
            db.query_row(
                "SELECT collection_url, base_url FROM mail_caldav_state WHERE account_id = ?1",
                params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })?;
    let collection = match cached {
        Some((Some(url), Some(cached_base))) if cached_base == base => collection_url(&url)?,
        _ => {
            let start = Url::parse(&base).map_err(|e| format!("invalid CalDAV URL: {e}"))?;
            collection_url(client.discover(&start).await?.as_str())?
        }
    };
    Ok((
        CalDavTarget {
            client,
            collection,
            base,
        },
        account_id,
    ))
}

fn save_state(
    conn: &Connection,
    account_id: &str,
    target: &CalDavTarget,
    error: Option<&str>,
) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO mail_caldav_state (account_id, base_url, collection_url, last_sync, last_error)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_id) DO UPDATE SET base_url = excluded.base_url,
            collection_url = excluded.collection_url, last_sync = excluded.last_sync,
            last_error = excluded.last_error",
        params![account_id, target.base, target.collection.as_str(), now_ts(), error],
    )?;
    Ok(())
}

/// Refresh the agenda cache from the account's CalDAV calendar.
#[tauri::command]
pub async fn mail_caldav_sync(
    config: MailAccountConfig,
    state: State<'_, AppState>,
) -> Result<MailCalDavSyncResult, String> {
    let (target, account_id) = open_calendar(&state, config).await?;
    let mut result = MailCalDavSyncResult {
        collection: target.collection.to_string(),
        ..MailCalDavSyncResult::default()
    };
    match pull(&target.client, &target.collection, now_ts()).await {
        Ok(resources) => {
            result.events = with_mail_db(&state, &account_id, |db| {
                let count = store_events(db, &account_id, &resources, true)?;
                save_state(db, &account_id, &target, None)?;
                Ok(count)
            })?;
        }
        Err(e) => {
            let _ = with_mail_db(&state, &account_id, |db| {
                save_state(db, &account_id, &target, Some(&e))
            });
            result.errors.push(e);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn mail_list_agenda(
    account_id: String,
    days: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<MailAgendaEvent>, String> {
    let days = days.unwrap_or(14).clamp(1, FUTURE_DAYS);
    with_mail_db(&state, &account_id, |db| {
        agenda(db, &account_id, now_ts(), days)
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCalendarWriteResult {
    pub href: String,
    pub created: bool,
}

/// Write an invitation into the CalDAV calendar (DEC-14), with my reply.
#[tauri::command]
pub async fn mail_add_invite_to_calendar(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    partstat: Option<String>,
    state: State<'_, AppState>,
) -> Result<MailCalendarWriteResult, String> {
    let me = config.email_address.clone();
    let invite = super::calendar::mail_get_invite(config.clone(), folder, uid, state.clone())
        .await?
        .ok_or_else(|| "this message has no calendar invitation".to_string())?;
    if invite.method == "CANCEL" {
        return Err("a cancelled meeting cannot be added to the calendar".into());
    }
    let partstat = partstat
        .map(|p| p.trim().to_ascii_uppercase())
        .filter(|p| matches!(p.as_str(), "ACCEPTED" | "TENTATIVE" | "DECLINED"));
    let body = invite_resource(&invite.ics, &me, partstat.as_deref());
    let (target, account_id) = open_calendar(&state, config).await?;
    let name: String = invite
        .uid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let href = href_path(&target.collection, &format!("{name}.ics"));
    let url = target.collection.join(&href).map_err(|e| e.to_string())?;
    let put = |condition: (&'static str, String)| {
        let body = body.clone();
        let client = &target.client;
        let url = url.clone();
        async move {
            client
                .send(
                    "PUT",
                    &url,
                    None,
                    Some((body, "text/calendar; charset=utf-8")),
                    &[condition],
                )
                .await
        }
    };
    let mut reply = put(("If-None-Match", "*".into())).await?;
    let mut created = true;
    if reply.status == 412 {
        // Already in the calendar (e.g. an updated invitation): replace it.
        reply = put(("If-Match", "*".into())).await?;
        created = false;
    }
    if !(200..300).contains(&reply.status) {
        return Err(format!("CalDAV rejected the event (HTTP {})", reply.status));
    }
    let events = parse_events(&body);
    with_mail_db(&state, &account_id, |db| {
        store_events(db, &account_id, &[(href.clone(), events)], false)?;
        save_state(db, &account_id, &target, None)
    })?;
    Ok(MailCalendarWriteResult { href, created })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPANDED: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:standup\r\nRECURRENCE-ID:20261005T010000Z\r\nDTSTART:20261005T010000Z\r\nDTEND:20261005T011500Z\r\nSUMMARY:Standup\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:standup\r\nRECURRENCE-ID:20261006T010000Z\r\nDTSTART:20261006T010000Z\r\nDTEND:20261006T011500Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn parses_expanded_instances_and_alarms() {
        let events = parse_events(EXPANDED);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].start, Some(1_791_162_000));
        assert_eq!(events[0].end, Some(1_791_162_900));
        assert_eq!(events[0].alarm_minutes, Some(10));
        assert_eq!(events[1].instance, "20261006T010000Z");
        assert_eq!(events[1].alarm_minutes, None);
        let day = parse_events(
            "BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261010\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n",
        );
        assert!(day[0].all_day);
        assert_eq!(day[0].end, day[0].start.map(|s| s + 86_400));
        assert_eq!(trigger_minutes("-P1DT2H"), Some(26 * 60));
        assert_eq!(trigger_minutes("PT5M"), None, "after the start");
        assert_eq!(trigger_minutes("PT0S"), Some(0));
    }

    #[test]
    fn report_bodies_yield_resources_with_events() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/u/work/standup.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:standup
DTSTART:20261005T010000Z
SUMMARY:Standup &amp; review
END:VEVENT
END:VCALENDAR
</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let collection = Url::parse("https://dav.example/cal/u/work/").unwrap();
        let resources: Vec<_> = parse_multistatus(xml)
            .into_iter()
            .filter_map(|r| {
                Some((
                    href_path(&collection, &r.href),
                    parse_events(r.props.get("calendar-data")?),
                ))
            })
            .collect();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].0, "/cal/u/work/standup.ics");
        assert_eq!(resources[0].1[0].summary, "Standup & review");
    }

    #[test]
    fn invite_resource_drops_method_and_sets_my_reply() {
        let ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:x\r\nATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;CN=Me:mailto:Me@Example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:other@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let out = invite_resource(ics, "me@example.com", Some("ACCEPTED"));
        assert!(!out.contains("METHOD"));
        assert!(
            out.contains("ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:Me@Example.com\r\n"),
            "{out}"
        );
        assert!(out.contains("ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:other@example.com\r\n"));
        assert!(invite_resource(ics, "me@example.com", None).contains("RSVP=TRUE"));
    }

    #[test]
    fn agenda_window_and_order() {
        let conn = Connection::open_in_memory().unwrap();
        crate::mail::init_mail_tables(&conn).unwrap();
        let now = 1_791_160_000;
        let events = parse_events(EXPANDED);
        let mut past = events[0].clone();
        past.uid = "past".into();
        past.start = Some(now - 10_000);
        past.end = Some(now - 5_000);
        let resources = vec![
            ("/cal/standup.ics".to_string(), events),
            ("/cal/past.ics".to_string(), vec![past]),
        ];
        assert_eq!(store_events(&conn, "acct", &resources, true).unwrap(), 3);
        let upcoming = agenda(&conn, "acct", now, 14).unwrap();
        assert_eq!(upcoming.len(), 2, "finished events are dropped");
        assert!(upcoming[0].start < upcoming[1].start);
        assert!(agenda(&conn, "acct", now, 1).unwrap().len() == 1);
        // Re-storing one resource replaces only its instances.
        store_events(
            &conn,
            "acct",
            &[("/cal/standup.ics".into(), Vec::new())],
            false,
        )
        .unwrap();
        assert!(agenda(&conn, "acct", now, 14).unwrap().is_empty());
        assert!(
            calendar_query(0, 86_400)
                .contains(r#"<c:expand start="19700101T000000Z" end="19700102T000000Z"/>"#)
        );
    }
}
