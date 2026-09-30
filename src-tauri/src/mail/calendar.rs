//! Calendar invitations in mail (TASK-20 phase 1: iTIP/iMIP, RFC 5545/5546/6047).
//!
//! A `text/calendar` part (METHOD REQUEST/CANCEL/REPLY) is parsed into a
//! [`MailInvite`] and cached with the body. Accept/Tentative/Decline sends an
//! iTIP `METHOD:REPLY` to the organizer as `text/calendar; method=REPLY`.
//! Times with a TZID are shown as the sender's wall-clock time plus zone name
//! (no tz database is bundled); UTC and date-only values are exact.

use std::sync::Arc;

use lettre::Message;
use lettre::message::header::ContentType;
use lettre::message::{Mailbox, MultiPart, SinglePart};
use mail_parser::{MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    ImapSessionOpts, MailAccountConfig, build_smtp_transport, now_ts, parse_mailbox,
    resolve_config, smtp_send_error, with_imap_session,
};
use crate::state::AppState;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailInviteTime {
    /// Epoch seconds when the value is UTC (`Z`) or a date.
    pub epoch: Option<i64>,
    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` as written (sender's wall clock).
    pub local: String,
    pub tzid: Option<String>,
    pub all_day: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailInviteAttendee {
    pub email: String,
    pub name: Option<String>,
    /// NEEDS-ACTION | ACCEPTED | TENTATIVE | DECLINED | DELEGATED
    pub partstat: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailInvite {
    /// REQUEST | CANCEL | REPLY | PUBLISH ...
    pub method: String,
    pub uid: String,
    pub sequence: u32,
    pub summary: String,
    pub location: Option<String>,
    pub description: Option<String>,
    pub start: Option<MailInviteTime>,
    pub end: Option<MailInviteTime>,
    pub organizer: Option<MailInviteAttendee>,
    pub attendees: Vec<MailInviteAttendee>,
    /// VEVENT STATUS (CONFIRMED / TENTATIVE / CANCELLED).
    pub status: Option<String>,
    /// The original calendar text, for "Export .ics".
    pub ics: String,
}

/// RFC 5545 §3.1 unfolding: CRLF followed by a space/tab continues a line.
fn unfold(ics: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in ics.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if (line.starts_with(' ') || line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&line[1..]);
        } else if !line.is_empty() {
            lines.push(line.to_string());
        }
    }
    lines
}

/// `NAME;P1=a;P2="b":value` → (NAME, params, value).
fn split_property(line: &str) -> (String, Vec<(String, String)>, String) {
    let mut in_quotes = false;
    let mut colon = line.len();
    for (index, ch) in line.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                colon = index;
                break;
            }
            _ => {}
        }
    }
    let (head, value) = (&line[..colon], line.get(colon + 1..).unwrap_or(""));
    let mut parts = head.split(';');
    let name = parts.next().unwrap_or("").to_ascii_uppercase();
    let params = parts
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((
                key.to_ascii_uppercase(),
                value.trim_matches('"').to_string(),
            ))
        })
        .collect();
    (name, params, value.to_string())
}

fn unescape(value: &str) -> String {
    value
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn parse_time(value: &str, params: &[(String, String)]) -> Option<MailInviteTime> {
    let value = value.trim();
    let date_only = param(params, "VALUE") == Some("DATE") || value.len() == 8;
    let digits =
        |range: std::ops::Range<usize>| value.get(range).and_then(|s| s.parse::<u32>().ok());
    let (year, month, day) = (digits(0..4)? as i32, digits(4..6)?, digits(6..8)?);
    let date = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
    if date_only {
        return Some(MailInviteTime {
            epoch: date.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc().timestamp()),
            local: date.format("%Y-%m-%d").to_string(),
            tzid: None,
            all_day: true,
        });
    }
    let (hour, minute, second) = (digits(9..11)?, digits(11..13)?, digits(13..15).unwrap_or(0));
    let naive = date.and_hms_opt(hour, minute, second)?;
    let utc = value.ends_with('Z');
    Some(MailInviteTime {
        epoch: utc.then(|| naive.and_utc().timestamp()),
        local: naive.format("%Y-%m-%dT%H:%M").to_string(),
        tzid: if utc {
            Some("UTC".into())
        } else {
            param(params, "TZID").map(str::to_string)
        },
        all_day: false,
    })
}

fn person(value: &str, params: &[(String, String)]) -> MailInviteAttendee {
    let email = value
        .trim()
        .trim_start_matches("mailto:")
        .trim_start_matches("MAILTO:")
        .to_string();
    MailInviteAttendee {
        email,
        name: param(params, "CN").map(str::to_string),
        partstat: param(params, "PARTSTAT")
            .unwrap_or("NEEDS-ACTION")
            .to_ascii_uppercase(),
    }
}

/// Parse the first VEVENT of an iCalendar object.
pub(super) fn parse_invite(ics: &str) -> Option<MailInvite> {
    let mut invite = MailInvite {
        ics: ics.to_string(),
        ..MailInvite::default()
    };
    let mut in_event = false;
    let mut nested = 0usize;
    let mut seen_event = false;
    for line in unfold(ics) {
        let (name, params, value) = split_property(&line);
        match name.as_str() {
            "BEGIN" if value.eq_ignore_ascii_case("VEVENT") && !seen_event => {
                in_event = true;
                seen_event = true;
            }
            "BEGIN" if in_event => nested += 1,
            "END" if in_event && nested > 0 => nested -= 1,
            "END" if value.eq_ignore_ascii_case("VEVENT") => in_event = false,
            "METHOD" => invite.method = value.trim().to_ascii_uppercase(),
            _ if !in_event || nested > 0 => {}
            "UID" => invite.uid = value.trim().to_string(),
            "SEQUENCE" => invite.sequence = value.trim().parse().unwrap_or(0),
            "SUMMARY" => invite.summary = unescape(&value),
            "LOCATION" => invite.location = Some(unescape(&value)).filter(|v| !v.is_empty()),
            "DESCRIPTION" => invite.description = Some(unescape(&value)).filter(|v| !v.is_empty()),
            "STATUS" => invite.status = Some(value.trim().to_ascii_uppercase()),
            "DTSTART" => invite.start = parse_time(&value, &params),
            "DTEND" => invite.end = parse_time(&value, &params),
            "ORGANIZER" => invite.organizer = Some(person(&value, &params)),
            "ATTENDEE" => invite.attendees.push(person(&value, &params)),
            _ => {}
        }
    }
    (seen_event && !invite.uid.is_empty()).then_some(invite)
}

/// Find and parse a `text/calendar` part of a raw message.
pub(super) fn invite_from_message(raw: &[u8]) -> Option<MailInvite> {
    let message = MessageParser::default().parse(raw)?;
    message.parts.iter().find_map(|part| {
        let ct = part.content_type()?;
        let is_calendar = ct.c_type.eq_ignore_ascii_case("text")
            && ct
                .c_subtype
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case("calendar"));
        let is_ics = part
            .attachment_name()
            .is_some_and(|name| name.to_ascii_lowercase().ends_with(".ics"));
        if !is_calendar && !is_ics {
            return None;
        }
        let text = part
            .text_contents()
            .map(str::to_string)
            .unwrap_or_else(|| String::from_utf8_lossy(part.contents()).to_string());
        parse_invite(&text)
    })
}

fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

/// RFC 5545 folding at 75 octets.
fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut count = 0;
    for ch in line.chars() {
        let len = ch.len_utf8();
        if count + len > 75 {
            out.push_str("\r\n ");
            count = 1;
        }
        out.push(ch);
        count += len;
    }
    out
}

/// iTIP REPLY for `me` with `partstat` (RFC 5546 §3.2.3).
pub(super) fn build_reply_ics(
    invite: &MailInvite,
    me: &str,
    my_name: Option<&str>,
    partstat: &str,
    stamp: i64,
) -> String {
    let dtstamp = chrono::DateTime::from_timestamp(stamp, 0)
        .unwrap_or_default()
        .format("%Y%m%dT%H%M%SZ")
        .to_string();
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "PRODID:-//Taomni//Mail//EN".to_string(),
        "VERSION:2.0".to_string(),
        "METHOD:REPLY".to_string(),
        "BEGIN:VEVENT".to_string(),
        format!("UID:{}", invite.uid),
        format!("SEQUENCE:{}", invite.sequence),
        format!("DTSTAMP:{dtstamp}"),
    ];
    if let Some(organizer) = &invite.organizer {
        lines.push(format!("ORGANIZER:mailto:{}", organizer.email));
    }
    let cn = my_name
        .filter(|name| !name.trim().is_empty())
        .map(|name| format!(";CN=\"{}\"", name.replace('"', "'")))
        .unwrap_or_default();
    lines.push(format!("ATTENDEE;PARTSTAT={partstat}{cn}:mailto:{me}"));
    if !invite.summary.is_empty() {
        lines.push(format!("SUMMARY:{}", escape(&invite.summary)));
    }
    lines.push("END:VEVENT".to_string());
    lines.push("END:VCALENDAR".to_string());
    lines
        .iter()
        .map(|line| fold(line))
        .collect::<Vec<_>>()
        .join("\r\n")
        + "\r\n"
}

fn partstat_of(response: &str) -> Result<&'static str, String> {
    match response.to_ascii_lowercase().as_str() {
        "accept" | "accepted" => Ok("ACCEPTED"),
        "tentative" => Ok("TENTATIVE"),
        "decline" | "declined" => Ok("DECLINED"),
        other => Err(format!("unknown invitation response {other}")),
    }
}

/// Invite of a message, parsed from the raw message (local store for POP3).
/// The reader only asks when the body lists a calendar part, and invitations
/// are small, so the raw fetch is cheap.
#[tauri::command]
pub async fn mail_get_invite(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    state: State<'_, AppState>,
) -> Result<Option<MailInvite>, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    if super::pop3::is_pop3(&config) {
        let raw = super::local_cmds::raw(&state, &config.session_id, &folder, uid)?;
        return Ok(invite_from_message(&raw));
    }
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| Ok(invite_from_message(&imap.fetch_raw(&folder, uid)?)),
        )
    })
    .await
    .map_err(|e| format!("invite task failed: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailInviteResponse {
    pub partstat: String,
    pub sent_to: String,
}

/// Accept / tentatively accept / decline: send the iTIP REPLY (AC-62).
#[tauri::command]
pub async fn mail_respond_invite(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    response: String,
    state: State<'_, AppState>,
) -> Result<MailInviteResponse, String> {
    let partstat = partstat_of(&response)?;
    let invite = mail_get_invite(config.clone(), folder, uid, state.clone())
        .await?
        .ok_or_else(|| "this message has no calendar invitation".to_string())?;
    if invite.method != "REQUEST" {
        return Err(format!("cannot respond to a {} message", invite.method));
    }
    let organizer = invite
        .organizer
        .clone()
        .ok_or_else(|| "the invitation has no organizer".to_string())?;
    let account = resolve_config(&state, config)?;
    let me = account.config.email_address.trim().to_string();
    let my_name = account.config.display_name.clone();
    let ics = build_reply_ics(&invite, &me, my_name.as_deref(), partstat, now_ts());
    let verb = match partstat {
        "ACCEPTED" => "Accepted",
        "TENTATIVE" => "Tentative",
        _ => "Declined",
    };
    let subject = format!("{verb}: {}", invite.summary);
    let from = Mailbox::new(
        my_name.clone(),
        me.parse()
            .map_err(|e| format!("invalid from address: {e}"))?,
    );
    let to = parse_mailbox(&organizer.email)?;
    let text = format!(
        "{} has {} this invitation.",
        my_name.as_deref().unwrap_or(&me),
        verb.to_lowercase()
    );
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(text))
                .singlepart(
                    SinglePart::builder()
                        .header(
                            ContentType::parse("text/calendar; method=REPLY; charset=UTF-8")
                                .map_err(|e| format!("calendar content type: {e}"))?,
                        )
                        .body(ics),
                ),
        )
        .map_err(|e| format!("failed to build invitation reply: {e}"))?;
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        use lettre::Transport;
        let transport = build_smtp_transport(&account, &handle)?;
        transport
            .mailer
            .send(&message)
            .map(|_| ())
            .map_err(|e| smtp_send_error(&e.to_string()))
    })
    .await
    .map_err(|e| format!("invite reply task failed: {e}"))??;
    Ok(MailInviteResponse {
        partstat: partstat.to_string(),
        sent_to: organizer.email,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nPRODID:Microsoft Exchange Server 2010\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:China Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nORGANIZER;CN=Boss:mailto:boss@example.com\r\nATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me:mailto:me\r\n @example.com\r\nSUMMARY;LANGUAGE=en-US:Quarterly review\\, Q3\r\nDTSTART;TZID=China Standard Time:20261005T100000\r\nDTEND;TZID=China Standard Time:20261005T110000\r\nUID:040000008200E00074C5B7101A82E008\r\nSEQUENCE:2\r\nLOCATION:Room 1\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn parses_an_exchange_request() {
        let invite = parse_invite(REQUEST).unwrap();
        assert_eq!(invite.method, "REQUEST");
        assert_eq!(invite.summary, "Quarterly review, Q3");
        assert_eq!(invite.sequence, 2);
        assert_eq!(invite.location.as_deref(), Some("Room 1"));
        let start = invite.start.unwrap();
        assert_eq!(start.local, "2026-10-05T10:00");
        assert_eq!(start.tzid.as_deref(), Some("China Standard Time"));
        assert!(start.epoch.is_none());
        assert_eq!(invite.organizer.unwrap().email, "boss@example.com");
        assert_eq!(invite.attendees.len(), 1);
        assert_eq!(
            invite.attendees[0].email, "me@example.com",
            "folded line joined"
        );
        assert_eq!(invite.attendees[0].partstat, "NEEDS-ACTION");
    }

    #[test]
    fn utc_and_all_day_times() {
        let utc = parse_time("20261005T020000Z", &[]).unwrap();
        assert_eq!(utc.epoch, Some(1_791_165_600));
        let day = parse_time("20261005", &[("VALUE".into(), "DATE".into())]).unwrap();
        assert!(day.all_day);
        assert_eq!(day.local, "2026-10-05");
    }

    #[test]
    fn reply_is_an_itip_reply() {
        let invite = parse_invite(REQUEST).unwrap();
        let reply = build_reply_ics(
            &invite,
            "me@example.com",
            Some("Me"),
            "ACCEPTED",
            1_700_000_000,
        );
        assert!(reply.contains("METHOD:REPLY\r\n"));
        assert!(reply.contains("UID:040000008200E00074C5B7101A82E008\r\n"));
        assert!(reply.contains("SEQUENCE:2\r\n"));
        assert!(reply.contains("ATTENDEE;PARTSTAT=ACCEPTED;CN=\"Me\":mailto:me@example.com"));
        assert!(reply.contains("ORGANIZER:mailto:boss@example.com"));
        assert!(reply.contains("SUMMARY:Quarterly review\\, Q3"));
        assert!(reply.lines().all(|line| line.len() <= 76), "{reply}");
        assert_eq!(partstat_of("decline").unwrap(), "DECLINED");
        assert!(partstat_of("maybe").is_err());
    }

    #[test]
    fn finds_the_calendar_part_of_a_message() {
        let raw = format!(
            "From: boss@example.com\r\nTo: me@example.com\r\nSubject: Invitation\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nPlease come\r\n--b\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\n{REQUEST}--b--\r\n"
        );
        let invite = invite_from_message(raw.as_bytes()).unwrap();
        assert_eq!(invite.uid, "040000008200E00074C5B7101A82E008");
        // The reader looks the invite up only when the body lists a calendar part.
        let parsed = MessageParser::default().parse(raw.as_bytes()).unwrap();
        let listed: Vec<_> = parsed
            .attachments()
            .map(super::super::attachment_info)
            .collect();
        assert!(
            listed
                .iter()
                .any(|a| a.content_type.as_deref() == Some("text/calendar")),
            "{listed:?}"
        );
        let cancel = REQUEST
            .replace("METHOD:REQUEST", "METHOD:CANCEL")
            .replace("STATUS:CONFIRMED", "STATUS:CANCELLED");
        let cancelled = parse_invite(&cancel).unwrap();
        assert_eq!(
            (cancelled.method.as_str(), cancelled.status.as_deref()),
            ("CANCEL", Some("CANCELLED"))
        );
    }
}
