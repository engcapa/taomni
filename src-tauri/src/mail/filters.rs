//! Message filters (TASK-13, DEC-11): Thunderbird-style rules with several
//! conditions (all / any) and several actions, run on new INBOX mail while
//! the tab is open and manually on any folder.
//!
//! Rules live per account in `mail_filters`. `mail_filter_marks` remembers
//! the highest UID already offered to the incoming filters per folder, so a
//! message is filtered once and old mail is never re-filtered. Actions reuse
//! the regular mail commands (which keep the cache in step); a failing
//! action leaves the message where it is and is reported (AC-42).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};

use regex::RegexBuilder;
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    ActiveImapSession, ImapSessionOpts, MailAccountConfig, MailMessageHeader, now_ts,
    resolve_config, row_to_header, sync::quote_imap_string, with_imap_session, with_mail_db,
};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MailFilterField {
    From,
    To,
    Cc,
    ToOrCc,
    Subject,
    Body,
    /// Message size in KB.
    SizeKb,
    /// Days since the Date header.
    AgeDays,
    /// IMAP keyword (tag) present.
    Tag,
    HasAttachment,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MailFilterOp {
    Contains,
    NotContains,
    Is,
    IsNot,
    BeginsWith,
    EndsWith,
    Matches,
    GreaterThan,
    LessThan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailFilterCondition {
    pub field: MailFilterField,
    pub op: MailFilterOp,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MailFilterActionKind {
    MoveTo,
    CopyTo,
    MarkRead,
    MarkUnread,
    Star,
    AddTag,
    Delete,
    Forward,
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailFilterAction {
    pub kind: MailFilterActionKind,
    /// Folder (move/copy), keyword (tag) or address (forward).
    #[serde(default)]
    pub value: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailFilter {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Any condition matches (instead of all).
    #[serde(default)]
    pub match_any: bool,
    pub conditions: Vec<MailFilterCondition>,
    pub actions: Vec<MailFilterAction>,
    /// Run on new INBOX mail (manual runs always apply).
    #[serde(default = "default_true")]
    pub on_incoming: bool,
}

/// A message as the evaluator sees it. `body` is the cached text body; when
/// it is `None` body conditions ask `server_body` (server-side SEARCH).
pub(super) struct FilterMessage<'a> {
    pub header: &'a MailMessageHeader,
    pub body: Option<&'a str>,
    pub server_body: Option<&'a HashSet<String>>,
    pub now: i64,
}

fn text_matches(op: MailFilterOp, haystack: &str, needle: &str) -> bool {
    let hay = haystack.to_lowercase();
    let needle_lower = needle.to_lowercase();
    match op {
        MailFilterOp::Contains => hay.contains(&needle_lower),
        MailFilterOp::NotContains => !hay.contains(&needle_lower),
        MailFilterOp::Is => hay.trim() == needle_lower.trim(),
        MailFilterOp::IsNot => hay.trim() != needle_lower.trim(),
        MailFilterOp::BeginsWith => hay.trim_start().starts_with(needle_lower.trim()),
        MailFilterOp::EndsWith => hay.trim_end().ends_with(needle_lower.trim()),
        MailFilterOp::Matches => RegexBuilder::new(needle)
            .case_insensitive(true)
            .size_limit(1 << 20)
            .build()
            .is_ok_and(|re| re.is_match(haystack)),
        MailFilterOp::GreaterThan | MailFilterOp::LessThan => false,
    }
}

fn number_matches(op: MailFilterOp, actual: Option<f64>, value: &str) -> bool {
    let (Some(actual), Ok(limit)) = (actual, value.trim().parse::<f64>()) else {
        return false;
    };
    match op {
        MailFilterOp::GreaterThan => actual > limit,
        MailFilterOp::LessThan => actual < limit,
        MailFilterOp::Is => (actual - limit).abs() < f64::EPSILON,
        MailFilterOp::IsNot => (actual - limit).abs() >= f64::EPSILON,
        _ => false,
    }
}

fn address_text(addresses: &[&super::MailAddress]) -> String {
    addresses
        .iter()
        .map(|a| {
            format!(
                "{} <{}>",
                a.name.as_deref().unwrap_or(""),
                a.address.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Address fields: `is`/`begins`/`ends` compare each address (or name) on
/// its own, so "is boss@example.com" works on a multi-recipient To.
fn address_matches(op: MailFilterOp, addresses: &[&super::MailAddress], value: &str) -> bool {
    let each = |test: &dyn Fn(&str) -> bool| {
        addresses
            .iter()
            .any(|a| a.address.as_deref().is_some_and(test) || a.name.as_deref().is_some_and(test))
    };
    match op {
        MailFilterOp::Is | MailFilterOp::BeginsWith | MailFilterOp::EndsWith => {
            each(&|part| text_matches(op, part, value))
        }
        MailFilterOp::IsNot => !each(&|part| text_matches(MailFilterOp::Is, part, value)),
        _ => text_matches(op, &address_text(addresses), value),
    }
}

pub(super) fn condition_matches(condition: &MailFilterCondition, message: &FilterMessage) -> bool {
    let header = message.header;
    let value = condition.value.as_str();
    match condition.field {
        MailFilterField::From => {
            let from: Vec<_> = header.from.iter().collect();
            address_matches(condition.op, &from, value)
        }
        MailFilterField::To => {
            address_matches(condition.op, &header.to.iter().collect::<Vec<_>>(), value)
        }
        MailFilterField::Cc => {
            address_matches(condition.op, &header.cc.iter().collect::<Vec<_>>(), value)
        }
        MailFilterField::ToOrCc => {
            let all: Vec<_> = header.to.iter().chain(header.cc.iter()).collect();
            address_matches(condition.op, &all, value)
        }
        MailFilterField::Subject => text_matches(condition.op, &header.subject, value),
        MailFilterField::Body => match message.body {
            Some(body) => text_matches(condition.op, body, value),
            None => {
                let found = message
                    .server_body
                    .is_some_and(|hits| hits.contains(&value.to_lowercase()));
                match condition.op {
                    MailFilterOp::Contains => found,
                    MailFilterOp::NotContains => !found,
                    // Other body operators need the text; uncached bodies never match.
                    _ => false,
                }
            }
        },
        MailFilterField::SizeKb => number_matches(
            condition.op,
            header.raw_size.map(|size| size as f64 / 1024.0),
            value,
        ),
        MailFilterField::AgeDays => number_matches(
            condition.op,
            header
                .date_ts
                .map(|ts| (message.now - ts) as f64 / 86_400.0),
            value,
        ),
        MailFilterField::Tag => {
            let has = header
                .flags
                .iter()
                .any(|flag| flag.eq_ignore_ascii_case(value.trim()));
            match condition.op {
                MailFilterOp::IsNot | MailFilterOp::NotContains => !has,
                _ => has,
            }
        }
        MailFilterField::HasAttachment => {
            let has = header.has_attachments || header.attachment_count > 0;
            let wanted = !matches!(value.trim(), "false" | "no" | "0");
            match condition.op {
                MailFilterOp::IsNot => has != wanted,
                _ => has == wanted,
            }
        }
    }
}

pub(super) fn filter_matches(filter: &MailFilter, message: &FilterMessage) -> bool {
    if filter.conditions.is_empty() {
        return false;
    }
    if filter.match_any {
        filter
            .conditions
            .iter()
            .any(|c| condition_matches(c, message))
    } else {
        filter
            .conditions
            .iter()
            .all(|c| condition_matches(c, message))
    }
}

/// What the matching filters want done to one message.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct MessagePlan {
    pub matched: Vec<String>,
    pub mark_read: bool,
    pub mark_unread: bool,
    pub star: bool,
    pub tags: Vec<String>,
    pub copies: Vec<String>,
    pub forwards: Vec<String>,
    /// Final location; moves and deletes end filtering for the message.
    pub move_to: Option<String>,
    pub delete: bool,
}

impl MessagePlan {
    fn is_empty(&self) -> bool {
        self.matched.is_empty()
    }
}

/// Run `filters` in order against one message (Thunderbird semantics: every
/// matching filter applies; "Stop", move and delete end the chain).
pub(super) fn plan_message(filters: &[&MailFilter], message: &FilterMessage) -> MessagePlan {
    let mut plan = MessagePlan::default();
    'filters: for filter in filters {
        if !filter.enabled || !filter_matches(filter, message) {
            continue;
        }
        plan.matched.push(filter.name.clone());
        for action in &filter.actions {
            let value = action
                .value
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            match action.kind {
                MailFilterActionKind::MarkRead => {
                    plan.mark_read = true;
                    plan.mark_unread = false;
                }
                MailFilterActionKind::MarkUnread => {
                    plan.mark_unread = true;
                    plan.mark_read = false;
                }
                MailFilterActionKind::Star => plan.star = true,
                MailFilterActionKind::AddTag => {
                    if let Some(tag) = value.filter(|t| !plan.tags.iter().any(|x| x == t)) {
                        plan.tags.push(tag.to_string());
                    }
                }
                MailFilterActionKind::CopyTo => {
                    if let Some(folder) = value.filter(|f| *f != message.header.folder) {
                        plan.copies.push(folder.to_string());
                    }
                }
                MailFilterActionKind::Forward => {
                    if let Some(address) = value {
                        plan.forwards.push(address.to_string());
                    }
                }
                MailFilterActionKind::MoveTo => {
                    if let Some(folder) = value.filter(|f| *f != message.header.folder) {
                        plan.move_to = Some(folder.to_string());
                        break 'filters;
                    }
                }
                MailFilterActionKind::Delete => {
                    plan.delete = true;
                    break 'filters;
                }
                MailFilterActionKind::Stop => break 'filters,
            }
        }
    }
    plan
}

pub(super) fn validate_filter(filter: &MailFilter) -> Result<(), String> {
    let label = if filter.name.trim().is_empty() {
        "a filter"
    } else {
        filter.name.trim()
    };
    if filter.name.trim().is_empty() {
        return Err("every filter needs a name".into());
    }
    if filter.conditions.is_empty() {
        return Err(format!("{label}: add at least one condition"));
    }
    if filter.actions.is_empty() {
        return Err(format!("{label}: add at least one action"));
    }
    for condition in &filter.conditions {
        let numeric = matches!(
            condition.field,
            MailFilterField::SizeKb | MailFilterField::AgeDays
        );
        if numeric && condition.value.trim().parse::<f64>().is_err() {
            return Err(format!("{label}: \"{}\" is not a number", condition.value));
        }
        if condition.op == MailFilterOp::Matches {
            RegexBuilder::new(&condition.value)
                .size_limit(1 << 20)
                .build()
                .map_err(|e| format!("{label}: invalid regular expression: {e}"))?;
        }
        let flag_field = matches!(condition.field, MailFilterField::HasAttachment);
        if !numeric && !flag_field && condition.value.trim().is_empty() {
            return Err(format!("{label}: a condition has no value"));
        }
    }
    for action in &filter.actions {
        let needs_value = matches!(
            action.kind,
            MailFilterActionKind::MoveTo
                | MailFilterActionKind::CopyTo
                | MailFilterActionKind::AddTag
                | MailFilterActionKind::Forward
        );
        let value = action.value.as_deref().unwrap_or("").trim();
        if needs_value && value.is_empty() {
            return Err(format!("{label}: an action needs a folder, tag or address"));
        }
        if action.kind == MailFilterActionKind::Forward && !value.contains('@') {
            return Err(format!("{label}: forward needs an email address"));
        }
    }
    Ok(())
}

pub(super) fn migrate_filter_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_filters (
            account_id TEXT NOT NULL,
            id TEXT NOT NULL,
            position INTEGER NOT NULL,
            filter_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, id)
        );
        CREATE TABLE IF NOT EXISTS mail_filter_marks (
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            uid_validity INTEGER,
            high_uid INTEGER NOT NULL,
            PRIMARY KEY (account_id, folder)
        );",
    )
}

pub(super) fn load_filters(conn: &Connection, account_id: &str) -> SqlResult<Vec<MailFilter>> {
    let mut stmt = conn.prepare(
        "SELECT filter_json FROM mail_filters WHERE account_id = ?1 ORDER BY position, id",
    )?;
    let rows = stmt.query_map(params![account_id], |row| row.get::<_, String>(0))?;
    let mut filters = Vec::new();
    for json in rows {
        if let Ok(filter) = serde_json::from_str::<MailFilter>(&json?) {
            filters.push(filter);
        }
    }
    Ok(filters)
}

pub(super) fn store_filters(
    conn: &Connection,
    account_id: &str,
    filters: &[MailFilter],
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM mail_filters WHERE account_id = ?1",
        params![account_id],
    )?;
    for (position, filter) in filters.iter().enumerate() {
        tx.execute(
            "INSERT INTO mail_filters (account_id, id, position, filter_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                account_id,
                filter.id,
                position as i64,
                serde_json::to_string(filter).unwrap_or_default(),
                now_ts()
            ],
        )?;
    }
    tx.commit()
}

fn folder_uid_validity(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<Option<u32>> {
    conn.query_row(
        "SELECT uid_validity FROM mail_folders WHERE account_id = ?1 AND name = ?2",
        params![account_id, folder],
        |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map(|value| value.flatten().map(|v| v as u32))
}

fn max_cached_uid(conn: &Connection, account_id: &str, folder: &str) -> SqlResult<u32> {
    conn.query_row(
        "SELECT COALESCE(MAX(uid), 0) FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
        params![account_id, folder],
        |row| row.get::<_, i64>(0),
    )
    .map(|uid| uid as u32)
}

/// Highest UID already offered to the incoming filters, or `None` when the
/// mark is missing or belongs to an older UIDVALIDITY.
pub(super) fn filter_mark(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<Option<u32>> {
    let stored: Option<(Option<i64>, i64)> = conn
        .query_row(
            "SELECT uid_validity, high_uid FROM mail_filter_marks WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let current = folder_uid_validity(conn, account_id, folder)?;
    Ok(stored.and_then(|(validity, high)| {
        (validity.map(|v| v as u32) == current).then_some(high as u32)
    }))
}

pub(super) fn set_filter_mark(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    high: u32,
) -> SqlResult<()> {
    let validity = folder_uid_validity(conn, account_id, folder)?;
    conn.execute(
        "INSERT INTO mail_filter_marks (account_id, folder, uid_validity, high_uid)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(account_id, folder) DO UPDATE SET
            uid_validity = excluded.uid_validity, high_uid = excluded.high_uid",
        params![account_id, folder, validity, high],
    )?;
    Ok(())
}

/// Mark everything cached as already filtered (called when filters are saved
/// so only mail that arrives afterwards is filtered).
pub(super) fn ensure_filter_mark(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<()> {
    if filter_mark(conn, account_id, folder)?.is_none() {
        let high = max_cached_uid(conn, account_id, folder)?;
        set_filter_mark(conn, account_id, folder, high)?;
    }
    Ok(())
}

/// Cached headers (and text bodies) of the candidates, oldest first.
fn load_candidates(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    selection: &CandidateSelection,
) -> SqlResult<Vec<(MailMessageHeader, Option<String>)>> {
    let (clause, bound) = match selection {
        CandidateSelection::Above(uid) => ("AND uid > ?3", *uid as i64),
        CandidateSelection::All | CandidateSelection::Uids(_) => ("AND ?3 = ?3", 0),
    };
    let sql = format!(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, in_reply_to, references_json,
                list_unsubscribe_json, receipt_to, body_text
         FROM mail_messages WHERE account_id = ?1 AND folder = ?2 {clause} ORDER BY uid"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![account_id, folder, bound], |row| {
        Ok((row_to_header(row)?, row.get::<_, Option<String>>(21)?))
    })?;
    let wanted: Option<HashSet<u32>> = match selection {
        CandidateSelection::Uids(uids) => Some(uids.iter().copied().collect()),
        _ => None,
    };
    let mut out = Vec::new();
    for row in rows {
        let (header, body) = row?;
        if wanted.as_ref().is_none_or(|set| set.contains(&header.uid)) {
            out.push((header, body));
        }
    }
    Ok(out)
}

enum CandidateSelection {
    Above(u32),
    All,
    Uids(Vec<u32>),
}

/// Body needles used by `contains` / `does not contain` conditions.
fn body_needles(filters: &[&MailFilter]) -> Vec<String> {
    let mut needles: Vec<String> = filters
        .iter()
        .flat_map(|filter| filter.conditions.iter())
        .filter(|c| {
            c.field == MailFilterField::Body
                && matches!(c.op, MailFilterOp::Contains | MailFilterOp::NotContains)
        })
        .map(|c| c.value.to_lowercase())
        .filter(|value| !value.trim().is_empty())
        .collect();
    needles.sort();
    needles.dedup();
    needles
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn imap_body_hits<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    needles: &[String],
) -> Result<HashMap<u32, HashSet<String>>, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let mut hits: HashMap<u32, HashSet<String>> = HashMap::new();
    for needle in needles {
        for chunk in uids.chunks(500) {
            let charset = if needle.is_ascii() {
                ""
            } else {
                "CHARSET UTF-8 "
            };
            let criteria = format!(
                "{charset}UID {} BODY {}",
                uid_set(chunk),
                quote_imap_string(needle)
            );
            let found = session
                .uid_search(&criteria)
                .map_err(|e| format!("IMAP UID SEARCH BODY failed: {e}"))?;
            for uid in found {
                hits.entry(uid).or_default().insert(needle.clone());
            }
        }
    }
    Ok(hits)
}

impl ActiveImapSession {
    fn filter_body_hits(
        &mut self,
        folder: &str,
        uids: &[u32],
        needles: &[String],
    ) -> Result<HashMap<u32, HashSet<String>>, String> {
        match self {
            Self::Tls { session, .. } => imap_body_hits(session, folder, uids, needles),
            Self::Plain { session, .. } => imap_body_hits(session, folder, uids, needles),
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFilterRunResult {
    pub folder: String,
    pub examined: usize,
    pub matched: usize,
    /// Messages moved away (moved or deleted).
    pub moved: usize,
    /// Failed actions; the affected messages stay where they are (AC-42).
    pub errors: Vec<String>,
}

async fn raw_bytes(
    state: &State<'_, AppState>,
    config: &MailAccountConfig,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    if super::pop3::is_pop3(config) {
        return super::local_cmds::raw(state, &config.session_id, folder, uid);
    }
    let account = resolve_config(state, config.clone())?;
    let handle = tokio::runtime::Handle::current();
    let pool = std::sync::Arc::clone(&state.mail_imap_pool);
    let folder = folder.to_string();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| imap.fetch_raw(&folder, uid),
        )
    })
    .await
    .map_err(|e| format!("forward: fetch task failed: {e}"))?
}

/// Forward as a `message/rfc822` attachment (keeps the original intact).
async fn forward_message(
    state: &State<'_, AppState>,
    config: &MailAccountConfig,
    header: &MailMessageHeader,
    to: &str,
) -> Result<(), String> {
    let raw = raw_bytes(state, config, &header.folder, header.uid).await?;
    let path = std::env::temp_dir().join(format!(
        "taomni-filter-forward-{}-{}-{}.eml",
        std::process::id(),
        header.uid,
        now_ts()
    ));
    std::fs::write(&path, &raw).map_err(|e| format!("forward: cannot stage message: {e}"))?;
    let subject = if header.subject.trim().is_empty() {
        "Fwd: (no subject)".to_string()
    } else {
        format!("Fwd: {}", header.subject)
    };
    let request: super::MailSendRequest = serde_json::from_value(serde_json::json!({
        "to": [to],
        "subject": subject,
        "textBody": "Forwarded by a Taomni mail filter.\n",
        "attachments": [{
            "path": path.to_string_lossy(),
            "name": "forwarded-message.eml",
            "contentType": "message/rfc822",
        }],
    }))
    .map_err(|e| format!("forward: {e}"))?;
    let sent = super::mail_send_message(config.clone(), request, state.clone()).await;
    let _ = std::fs::remove_file(&path);
    sent.map(|_| ())
}

fn group(entries: impl IntoIterator<Item = (String, u32)>) -> BTreeMap<String, Vec<u32>> {
    let mut map: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (key, uid) in entries {
        map.entry(key).or_default().push(uid);
    }
    map
}

/// Run filters on a folder. `trigger = "incoming"` filters only mail newer
/// than the folder's filter mark (first run just sets the mark); `"manual"`
/// filters `uids` or every cached message of the folder.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mail_apply_filters(
    config: MailAccountConfig,
    folder: String,
    trigger: String,
    uids: Option<Vec<u32>>,
    filter_ids: Option<Vec<String>>,
    trash_folder: Option<String>,
    state: State<'_, AppState>,
) -> Result<MailFilterRunResult, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let incoming = trigger == "incoming";
    let account_id = config.session_id.clone();
    let mut result = MailFilterRunResult {
        folder: folder.clone(),
        ..MailFilterRunResult::default()
    };
    let (filters, candidates, new_high) = with_mail_db(&state, &account_id, |db| {
        let wanted: Option<HashSet<&String>> = filter_ids.as_ref().map(|ids| ids.iter().collect());
        let filters: Vec<MailFilter> = load_filters(db, &account_id)?
            .into_iter()
            .filter(|f| f.enabled && (!incoming || f.on_incoming))
            .filter(|f| wanted.as_ref().is_none_or(|ids| ids.contains(&f.id)))
            .collect();
        let selection = if incoming {
            match filter_mark(db, &account_id, &folder)? {
                Some(mark) => CandidateSelection::Above(mark),
                None => {
                    ensure_filter_mark(db, &account_id, &folder)?;
                    return Ok((Vec::new(), Vec::new(), None));
                }
            }
        } else {
            match &uids {
                Some(uids) => CandidateSelection::Uids(uids.clone()),
                None => CandidateSelection::All,
            }
        };
        let candidates = load_candidates(db, &account_id, &folder, &selection)?;
        let new_high = candidates.iter().map(|(h, _)| h.uid).max();
        Ok((filters, candidates, new_high))
    })?;
    result.examined = candidates.len();
    let finish_mark = |state: &State<'_, AppState>| -> Result<(), String> {
        if let (true, Some(high)) = (incoming, new_high) {
            with_mail_db(state, &account_id, |db| {
                set_filter_mark(db, &account_id, &folder, high)
            })?;
        }
        Ok(())
    };
    if filters.is_empty() || candidates.is_empty() {
        finish_mark(&state)?;
        return Ok(result);
    }
    let refs: Vec<&MailFilter> = filters.iter().collect();

    // Body conditions on mail whose body is not cached: ask the server (or
    // the local store for POP3).
    let needles = body_needles(&refs);
    let uncached: Vec<u32> = candidates
        .iter()
        .filter(|(_, body)| body.is_none())
        .map(|(h, _)| h.uid)
        .collect();
    let mut server_hits: HashMap<u32, HashSet<String>> = HashMap::new();
    let mut local_bodies: HashMap<u32, String> = HashMap::new();
    if !needles.is_empty() && !uncached.is_empty() {
        if super::pop3::is_pop3(&config) {
            for uid in &uncached {
                if let Ok(body) = super::local_cmds::get_body(&state, &account_id, &folder, *uid) {
                    local_bodies.insert(*uid, body.text.or(body.html).unwrap_or_default());
                }
            }
        } else {
            let account = resolve_config(&state, config.clone())?;
            let pool = std::sync::Arc::clone(&state.mail_imap_pool);
            let handle = tokio::runtime::Handle::current();
            let folder_for_task = folder.clone();
            let lookup = tokio::task::spawn_blocking(move || {
                with_imap_session(
                    &pool,
                    &account,
                    &handle,
                    ImapSessionOpts::default(),
                    |imap| imap.filter_body_hits(&folder_for_task, &uncached, &needles),
                )
            })
            .await
            .map_err(|e| format!("filter body search failed: {e}"))?;
            match lookup {
                Ok(hits) => server_hits = hits,
                Err(e) => result.errors.push(format!("body search: {e}")),
            }
        }
    }

    let now = now_ts();
    let empty = HashSet::new();
    let mut plans: Vec<(&MailMessageHeader, MessagePlan)> = Vec::new();
    for (header, body) in &candidates {
        let body = body
            .as_deref()
            .or(local_bodies.get(&header.uid).map(String::as_str));
        let message = FilterMessage {
            header,
            body,
            server_body: Some(server_hits.get(&header.uid).unwrap_or(&empty)),
            now,
        };
        let plan = plan_message(&refs, &message);
        if !plan.is_empty() {
            plans.push((header, plan));
        }
    }
    result.matched = plans.len();
    execute_plans(
        &state,
        &config,
        &folder,
        trash_folder.as_deref(),
        &plans,
        &mut result,
    )
    .await;
    finish_mark(&state)?;
    Ok(result)
}

async fn execute_plans(
    state: &State<'_, AppState>,
    config: &MailAccountConfig,
    folder: &str,
    trash_folder: Option<&str>,
    plans: &[(&MailMessageHeader, MessagePlan)],
    result: &mut MailFilterRunResult,
) {
    let uids_where = |test: &dyn Fn(&MessagePlan) -> bool| -> Vec<u32> {
        plans
            .iter()
            .filter(|(_, p)| test(p))
            .map(|(h, _)| h.uid)
            .collect()
    };
    let mut flag_ops: Vec<(Vec<u32>, Vec<String>, Vec<String>, &str)> = vec![
        (
            uids_where(&|p| p.mark_read),
            vec![r"\Seen".into()],
            vec![],
            "mark read",
        ),
        (
            uids_where(&|p| p.mark_unread),
            vec![],
            vec![r"\Seen".into()],
            "mark unread",
        ),
        (
            uids_where(&|p| p.star),
            vec![r"\Flagged".into()],
            vec![],
            "star",
        ),
    ];
    let tags = group(
        plans
            .iter()
            .flat_map(|(h, p)| p.tags.iter().map(move |t| (t.clone(), h.uid))),
    );
    for (tag, uids) in &tags {
        flag_ops.push((uids.clone(), vec![tag.clone()], vec![], "tag"));
    }
    for (uids, add, remove, label) in flag_ops {
        if uids.is_empty() {
            continue;
        }
        if let Err(e) = super::mail_set_flags(
            config.clone(),
            folder.to_string(),
            uids,
            Some(add),
            Some(remove),
            state.clone(),
        )
        .await
        {
            result.errors.push(format!("{label}: {e}"));
        }
    }

    let copies = group(
        plans
            .iter()
            .flat_map(|(h, p)| p.copies.iter().map(move |f| (f.clone(), h.uid))),
    );
    for (target, uids) in copies {
        if let Err(e) = super::mail_copy_messages(
            config.clone(),
            folder.to_string(),
            uids,
            target.clone(),
            state.clone(),
        )
        .await
        {
            result.errors.push(format!("copy to {target}: {e}"));
        }
    }

    for (header, plan) in plans {
        for to in &plan.forwards {
            if let Err(e) = forward_message(state, config, header, to).await {
                result.errors.push(format!("forward to {to}: {e}"));
            }
        }
    }

    // Moves last, so the other actions ran on the source copy.
    let trash = trash_folder
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != folder);
    let moves = group(plans.iter().filter_map(|(h, p)| {
        p.move_to
            .clone()
            .or_else(|| (p.delete).then(|| trash.map(str::to_string)).flatten())
            .map(|target| (target, h.uid))
    }));
    for (target, uids) in moves {
        let count = uids.len();
        match super::mail_move_messages(
            config.clone(),
            folder.to_string(),
            uids,
            target.clone(),
            state.clone(),
        )
        .await
        {
            Ok(_) => result.moved += count,
            Err(e) => result.errors.push(format!("move to {target}: {e}")),
        }
    }
    if trash.is_none() {
        let purge = uids_where(&|p| p.delete && p.move_to.is_none());
        if !purge.is_empty() {
            let count = purge.len();
            match super::mail_delete_messages(
                config.clone(),
                folder.to_string(),
                Some(purge),
                Some(false),
                state.clone(),
            )
            .await
            {
                Ok(_) => result.moved += count,
                Err(e) => result.errors.push(format!("delete: {e}")),
            }
        }
    }
    if !result.errors.is_empty() {
        tracing::warn!(folder = %folder, errors = ?result.errors, "mail filter actions failed");
    }
}

fn prepare_filters(mut filters: Vec<MailFilter>) -> Result<Vec<MailFilter>, String> {
    let mut seen = HashSet::new();
    let stamp = now_ts();
    for (index, filter) in filters.iter_mut().enumerate() {
        filter.name = filter.name.trim().to_string();
        validate_filter(filter)?;
        if filter.id.trim().is_empty() || !seen.insert(filter.id.clone()) {
            filter.id = format!("filter-{stamp}-{index}");
            seen.insert(filter.id.clone());
        }
    }
    Ok(filters)
}

#[tauri::command]
pub async fn mail_list_filters(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFilter>, String> {
    with_mail_db(&state, &account_id, |db| load_filters(db, &account_id))
}

/// Replace the account's filters (order = run order).
#[tauri::command]
pub async fn mail_save_filters(
    account_id: String,
    filters: Vec<MailFilter>,
    state: State<'_, AppState>,
) -> Result<Vec<MailFilter>, String> {
    let filters = prepare_filters(filters)?;
    with_mail_db(&state, &account_id, |db| {
        store_filters(db, &account_id, &filters)?;
        // Only mail arriving from now on is filtered on receipt.
        ensure_filter_mark(db, &account_id, "INBOX")?;
        load_filters(db, &account_id)
    })
}

#[derive(Debug, Serialize, Deserialize)]
struct FilterFile {
    format: String,
    version: u32,
    filters: Vec<MailFilter>,
}

const FILTER_FILE_FORMAT: &str = "taomni-mail-filters";

#[tauri::command]
pub async fn mail_export_filters(
    account_id: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let filters = with_mail_db(&state, &account_id, |db| load_filters(db, &account_id))?;
    let file = FilterFile {
        format: FILTER_FILE_FORMAT.into(),
        version: 1,
        filters,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(target_path.trim(), json)
        .map_err(|e| format!("failed to write filters: {e}"))?;
    Ok(file.filters.len())
}

/// Parse an exported filter file (or a bare JSON array of filters).
pub(super) fn parse_filter_file(text: &str) -> Result<Vec<MailFilter>, String> {
    if let Ok(file) = serde_json::from_str::<FilterFile>(text) {
        if file.format != FILTER_FILE_FORMAT {
            return Err(format!("not a Taomni filter file ({})", file.format));
        }
        return Ok(file.filters);
    }
    serde_json::from_str::<Vec<MailFilter>>(text).map_err(|e| format!("invalid filter file: {e}"))
}

/// Append the filters of a file after the existing ones.
#[tauri::command]
pub async fn mail_import_filters(
    account_id: String,
    source_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFilter>, String> {
    let text = std::fs::read_to_string(source_path.trim())
        .map_err(|e| format!("failed to read filters: {e}"))?;
    let imported = parse_filter_file(&text)?;
    with_mail_db(&state, &account_id, |db| {
        let mut all = load_filters(db, &account_id)?;
        let known: HashSet<String> = all.iter().map(|f| f.id.clone()).collect();
        all.extend(imported.into_iter().map(|mut f| {
            if known.contains(&f.id) {
                f.id.clear();
            }
            f
        }));
        Ok(all)
    })
    .and_then(|all| prepare_filters(all))
    .and_then(|all| {
        with_mail_db(&state, &account_id, |db| {
            store_filters(db, &account_id, &all)?;
            ensure_filter_mark(db, &account_id, "INBOX")?;
            load_filters(db, &account_id)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::MailAddress;

    fn header(uid: u32, from: &str, subject: &str) -> MailMessageHeader {
        MailMessageHeader {
            account_id: "acct".into(),
            folder: "INBOX".into(),
            uid,
            message_id: None,
            subject: subject.into(),
            from: Some(MailAddress {
                name: Some("Boss".into()),
                address: Some(from.into()),
            }),
            to: vec![MailAddress {
                name: None,
                address: Some("me@example.com".into()),
            }],
            cc: Vec::new(),
            date_ts: Some(1_700_000_000),
            flags: Vec::new(),
            has_attachments: false,
            attachment_count: 0,
            attachments: Vec::new(),
            snippet: None,
            raw_size: Some(4096),
            body_cached: false,
            in_reply_to: None,
            references: Vec::new(),
            list_unsubscribe: None,
            receipt_to: None,
        }
    }

    fn cond(field: MailFilterField, op: MailFilterOp, value: &str) -> MailFilterCondition {
        MailFilterCondition {
            field,
            op,
            value: value.into(),
        }
    }

    fn action(kind: MailFilterActionKind, value: Option<&str>) -> MailFilterAction {
        MailFilterAction {
            kind,
            value: value.map(str::to_string),
        }
    }

    fn filter(
        name: &str,
        conditions: Vec<MailFilterCondition>,
        actions: Vec<MailFilterAction>,
    ) -> MailFilter {
        MailFilter {
            id: name.into(),
            name: name.into(),
            enabled: true,
            match_any: false,
            conditions,
            actions,
            on_incoming: true,
        }
    }

    fn message<'a>(header: &'a MailMessageHeader, body: Option<&'a str>) -> FilterMessage<'a> {
        FilterMessage {
            header,
            body,
            server_body: None,
            now: 1_700_000_000 + 10 * 86_400,
        }
    }

    #[test]
    fn conditions_cover_fields_and_operators() {
        let h = header(1, "boss@example.com", "Weekly Report 42");
        let m = message(&h, Some("Please find the numbers attached"));
        let yes = [
            cond(MailFilterField::From, MailFilterOp::Is, "BOSS@example.com"),
            cond(
                MailFilterField::From,
                MailFilterOp::EndsWith,
                "@example.com",
            ),
            cond(MailFilterField::From, MailFilterOp::Contains, "boss"),
            cond(MailFilterField::ToOrCc, MailFilterOp::Is, "me@example.com"),
            cond(MailFilterField::Subject, MailFilterOp::BeginsWith, "weekly"),
            cond(
                MailFilterField::Subject,
                MailFilterOp::Matches,
                r"report \d+$",
            ),
            cond(MailFilterField::Body, MailFilterOp::Contains, "NUMBERS"),
            cond(MailFilterField::SizeKb, MailFilterOp::GreaterThan, "3"),
            cond(MailFilterField::AgeDays, MailFilterOp::GreaterThan, "7"),
            cond(MailFilterField::Tag, MailFilterOp::IsNot, "$label1"),
            cond(MailFilterField::HasAttachment, MailFilterOp::Is, "false"),
        ];
        for c in &yes {
            assert!(condition_matches(c, &m), "{c:?}");
        }
        let no = [
            cond(
                MailFilterField::From,
                MailFilterOp::IsNot,
                "boss@example.com",
            ),
            cond(
                MailFilterField::Subject,
                MailFilterOp::NotContains,
                "report",
            ),
            cond(MailFilterField::SizeKb, MailFilterOp::LessThan, "2"),
            cond(MailFilterField::Cc, MailFilterOp::Contains, "me@"),
            cond(MailFilterField::Subject, MailFilterOp::Matches, "("),
        ];
        for c in &no {
            assert!(!condition_matches(c, &m), "{c:?}");
        }
    }

    #[test]
    fn uncached_bodies_use_server_hits() {
        let h = header(1, "a@example.com", "x");
        let hits: HashSet<String> = ["invoice".to_string()].into_iter().collect();
        let m = FilterMessage {
            header: &h,
            body: None,
            server_body: Some(&hits),
            now: 0,
        };
        let body = |op, value| cond(MailFilterField::Body, op, value);
        assert!(condition_matches(
            &body(MailFilterOp::Contains, "Invoice"),
            &m
        ));
        assert!(!condition_matches(
            &body(MailFilterOp::NotContains, "invoice"),
            &m
        ));
        assert!(condition_matches(
            &body(MailFilterOp::NotContains, "refund"),
            &m
        ));
        assert!(!condition_matches(&body(MailFilterOp::Is, "invoice"), &m));
    }

    #[test]
    fn plans_follow_thunderbird_semantics() {
        let h = header(1, "boss@example.com", "Weekly report");
        let m = message(&h, None);
        let from_boss = || vec![cond(MailFilterField::From, MailFilterOp::Contains, "boss")];
        let tag = filter(
            "tag",
            from_boss(),
            vec![
                action(MailFilterActionKind::AddTag, Some("$label1")),
                action(MailFilterActionKind::MarkRead, None),
            ],
        );
        let mut any = filter(
            "any",
            vec![
                cond(MailFilterField::Subject, MailFilterOp::Contains, "nope"),
                cond(MailFilterField::Subject, MailFilterOp::Contains, "weekly"),
            ],
            vec![action(MailFilterActionKind::MoveTo, Some("Reports"))],
        );
        any.match_any = true;
        let after = filter(
            "after",
            from_boss(),
            vec![action(MailFilterActionKind::Star, None)],
        );
        let plan = plan_message(&[&tag, &any, &after], &m);
        assert_eq!(plan.matched, vec!["tag", "any"]);
        assert_eq!(plan.tags, vec!["$label1"]);
        assert!(plan.mark_read);
        assert_eq!(plan.move_to.as_deref(), Some("Reports"));
        assert!(!plan.star, "a move ends the chain");

        let stop = filter(
            "stop",
            from_boss(),
            vec![action(MailFilterActionKind::Stop, None)],
        );
        let mut disabled = after.clone();
        disabled.enabled = false;
        assert_eq!(plan_message(&[&disabled], &m), MessagePlan::default());
        assert_eq!(plan_message(&[&stop, &after], &m).matched, vec!["stop"]);
        let same_folder = filter(
            "noop",
            from_boss(),
            vec![
                action(MailFilterActionKind::MoveTo, Some("INBOX")),
                action(MailFilterActionKind::Star, None),
            ],
        );
        let plan = plan_message(&[&same_folder], &m);
        assert!(plan.move_to.is_none() && plan.star);
    }

    #[test]
    fn validation_rejects_incomplete_rules() {
        let ok = filter(
            "ok",
            vec![cond(MailFilterField::From, MailFilterOp::Contains, "a")],
            vec![action(MailFilterActionKind::MoveTo, Some("Archive"))],
        );
        assert!(validate_filter(&ok).is_ok());
        let mut bad = ok.clone();
        bad.name = " ".into();
        assert!(validate_filter(&bad).is_err());
        let mut bad = ok.clone();
        bad.actions = vec![action(MailFilterActionKind::MoveTo, None)];
        assert!(validate_filter(&bad).is_err());
        let mut bad = ok.clone();
        bad.conditions = vec![cond(
            MailFilterField::SizeKb,
            MailFilterOp::GreaterThan,
            "big",
        )];
        assert!(validate_filter(&bad).is_err());
        let mut bad = ok.clone();
        bad.conditions = vec![cond(MailFilterField::Subject, MailFilterOp::Matches, "(")];
        assert!(
            validate_filter(&bad)
                .unwrap_err()
                .contains("regular expression")
        );
        let mut bad = ok;
        bad.actions = vec![action(MailFilterActionKind::Forward, Some("nobody"))];
        assert!(validate_filter(&bad).is_err());
    }

    #[test]
    fn storage_marks_and_files() {
        let conn = Connection::open_in_memory().unwrap();
        crate::mail::init_mail_tables(&conn).unwrap();
        let f = filter(
            "a",
            vec![cond(MailFilterField::From, MailFilterOp::Contains, "a")],
            vec![action(MailFilterActionKind::Star, None)],
        );
        let prepared = prepare_filters(vec![f.clone(), f]).unwrap();
        assert_ne!(prepared[0].id, prepared[1].id, "duplicate ids are replaced");
        store_filters(&conn, "acct", &prepared).unwrap();
        assert_eq!(load_filters(&conn, "acct").unwrap(), prepared);
        assert!(load_filters(&conn, "other").unwrap().is_empty());

        conn.execute(
            "INSERT INTO mail_folders (account_id, name, uid_validity, updated_at)
             VALUES ('acct', 'INBOX', 7, 0)",
            [],
        )
        .unwrap();
        let insert = |uid: u32| {
            conn.execute(
                "INSERT INTO mail_messages (account_id, folder, uid, updated_at)
                 VALUES ('acct', 'INBOX', ?1, 0)",
                params![uid],
            )
            .unwrap();
        };
        insert(3);
        insert(9);
        assert_eq!(filter_mark(&conn, "acct", "INBOX").unwrap(), None);
        ensure_filter_mark(&conn, "acct", "INBOX").unwrap();
        assert_eq!(filter_mark(&conn, "acct", "INBOX").unwrap(), Some(9));
        insert(12);
        let fresh = load_candidates(&conn, "acct", "INBOX", &CandidateSelection::Above(9)).unwrap();
        assert_eq!(
            fresh.iter().map(|(h, _)| h.uid).collect::<Vec<_>>(),
            vec![12]
        );
        let picked = load_candidates(
            &conn,
            "acct",
            "INBOX",
            &CandidateSelection::Uids(vec![3, 12]),
        )
        .unwrap();
        assert_eq!(picked.len(), 2);
        // A UIDVALIDITY change invalidates the mark.
        conn.execute("UPDATE mail_folders SET uid_validity = 8", [])
            .unwrap();
        assert_eq!(filter_mark(&conn, "acct", "INBOX").unwrap(), None);

        let file = serde_json::to_string(&FilterFile {
            format: FILTER_FILE_FORMAT.into(),
            version: 1,
            filters: prepared.clone(),
        })
        .unwrap();
        assert_eq!(parse_filter_file(&file).unwrap(), prepared);
        let bare = serde_json::to_string(&prepared).unwrap();
        assert_eq!(parse_filter_file(&bare).unwrap(), prepared);
        assert!(parse_filter_file(r#"{"format":"x","version":1,"filters":[]}"#).is_err());
    }

    #[test]
    fn server_body_search_is_limited_to_the_candidates() {
        let fake = super::super::fake_imap::FakeImap::start(false);
        let message = |body: &str| {
            format!("From: a@example.com\r\nSubject: s\r\n\r\n{body}\r\n").into_bytes()
        };
        let invoice = fake.deliver_raw("INBOX", message("Your INVOICE is ready"));
        let other = fake.deliver_raw("INBOX", message("nothing here"));
        let outside = fake.deliver_raw("INBOX", message("another invoice"));
        let mut session = fake.session();
        let hits = imap_body_hits(
            &mut session,
            "INBOX",
            &[invoice, other],
            &["invoice".to_string(), "refund".to_string()],
        )
        .unwrap();
        assert_eq!(
            hits.get(&invoice).map(|set| set.contains("invoice")),
            Some(true)
        );
        assert!(!hits.contains_key(&other));
        assert!(
            !hits.contains_key(&outside),
            "only the requested UIDs are searched"
        );
    }
}
