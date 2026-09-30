//! Gap-free IMAP folder synchronisation.
//!
//! Invariant (per account + folder, stable UIDVALIDITY): the cache holds
//! exactly the server messages whose UID lies in `[sync_low_uid,
//! sync_high_uid]`. New mail is therefore always `sync_high_uid+1:*`, older
//! history is `1:sync_low_uid-1`, and reconciliation only needs to compare the
//! server's UID set inside the span with the cached one.
//!
//! The previous design inferred progress from `MAX(uid)` of a cache that was
//! filled by newest-N pages, so a newest page after a long absence pushed the
//! resume point past the messages in between and they were never fetched.
//! Every fetch here is planned as a set difference (server − cached), which is
//! idempotent: an interrupted step is simply recomputed by the next call.

use std::collections::HashSet;
use std::io::{Read, Write};

use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};

use super::{
    MailCacheSettings, MailFolder, MailMessageCached, MailMessageHeader, ResolvedMailAccount,
    decode_imap_modified_utf7, fetch_flag_strings, imap_fetch_messages_for_uids,
    imap_page_uids_newest_first, imap_unread_count, now_ts, prune_mail_cache,
    reindex_cached_contacts, uid_set_string, upsert_folder, upsert_message,
};

/// Newest cached UIDs whose flags a quiet reconcile refreshes when the server
/// cannot report changes via CONDSTORE.
pub(super) const FLAG_RECONCILE_WINDOW: usize = 500;
/// UIDs per `UID FETCH (FLAGS)` command.
const FLAG_FETCH_CHUNK: usize = 1000;
const MAIL_SCHEMA_VERSION: i64 = 6;

/// Which work a `mail_sync_folder` call should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSyncRequestMode {
    /// Initialise / repair / fetch new mail, whichever the stored state needs.
    #[default]
    Auto,
    Catchup,
    /// Fetch the next block of older history below `sync_low_uid`.
    Backfill,
    /// Reconcile deletions and flags for the newest cached window.
    Reconcile,
    /// Reconcile deletions and flags for the whole cached span.
    ReconcileFull,
}

/// The work a step actually performed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSyncMode {
    Initial,
    Repair,
    Catchup,
    Backfill,
    Reconcile,
    ReconcileFull,
    /// Cache disabled: a stateless newest page was fetched.
    Uncached,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolderSyncResult {
    pub account_id: String,
    pub folder: MailFolder,
    pub mode: MailSyncMode,
    /// Headers fetched by this step (newest first).
    pub messages: Vec<MailMessageHeader>,
    pub fetched: usize,
    /// Newly arrived messages without `\Seen` (never counts initial sync,
    /// repair of an old gap or history backfill).
    pub new_unseen: usize,
    pub vanished: usize,
    pub flags_updated: usize,
    /// Messages still missing in the planned range after this step.
    pub remaining_new: usize,
    /// True when the caller should call again to finish the requested work.
    pub more: bool,
    pub sync_complete: bool,
    pub uid_validity_reset: bool,
    pub synced_at: i64,
}

/// Persisted per-folder sync state plus the cached UID set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct FolderSyncState {
    pub uid_validity: Option<u32>,
    pub low: Option<u32>,
    pub high: Option<u32>,
    pub complete: bool,
    /// The span was adopted from a pre-watermark cache and still has to be
    /// verified against the server (it may contain gaps).
    pub needs_repair: bool,
    pub highest_modseq: Option<u64>,
    /// Sorted, de-duplicated cached UIDs of the folder.
    pub cached_uids: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Watermark {
    pub low: Option<u32>,
    pub high: Option<u32>,
    pub complete: bool,
    pub needs_repair: bool,
}

/// Result of one IMAP step before it is written to the cache.
#[derive(Debug)]
pub(super) struct FolderStepOutcome {
    pub folder: MailFolder,
    pub mode: MailSyncMode,
    pub messages: Vec<MailMessageCached>,
    pub vanished: Vec<u32>,
    pub flag_updates: Vec<(u32, Vec<String>)>,
    pub watermark: Watermark,
    /// New HIGHESTMODSEQ to store once flags were fully reconciled.
    pub highest_modseq: Option<u64>,
    pub reconciled: bool,
    pub uid_validity_reset: bool,
    pub remaining: usize,
    pub more: bool,
    pub new_unseen: usize,
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/// Idempotent schema upgrade; cheap when already current (called per open).
pub fn migrate_mail_tables(conn: &Connection) -> SqlResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version >= MAIL_SCHEMA_VERSION {
        return Ok(());
    }
    let folder_columns = [
        ("sync_low_uid", "INTEGER"),
        ("sync_high_uid", "INTEGER"),
        ("sync_complete", "INTEGER NOT NULL DEFAULT 0"),
        ("sync_needs_repair", "INTEGER NOT NULL DEFAULT 0"),
        ("highest_modseq", "INTEGER"),
        ("last_reconcile_at", "INTEGER"),
        ("last_error", "TEXT"),
    ];
    for (name, decl) in folder_columns {
        add_column_if_missing(conn, "mail_folders", name, decl)?;
    }
    add_column_if_missing(conn, "mail_messages", "internal_ts", "INTEGER")?;
    // v3: reply threading.
    add_column_if_missing(conn, "mail_messages", "in_reply_to", "TEXT")?;
    add_column_if_missing(
        conn,
        "mail_messages",
        "references_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    // v5: mailing-list unsubscribe (TASK-18).
    add_column_if_missing(conn, "mail_messages", "list_unsubscribe_json", "TEXT")?;
    // v6: when this client last changed the flags (ms), so a reconcile that
    // read the server before our STORE does not undo it.
    add_column_if_missing(conn, "mail_messages", "flags_local_at", "INTEGER")?;
    // v4: local full-text index.
    if version < 4 {
        super::search::migrate_search_index(conn)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {MAIL_SCHEMA_VERSION};"))
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> SqlResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name.eq_ignore_ascii_case(column));
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

pub(super) fn load_folder_sync_state(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<FolderSyncState> {
    let row: Option<(Option<u32>, Option<u32>, Option<u32>, i64, i64, Option<i64>)> = conn
        .query_row(
            "SELECT uid_validity, sync_low_uid, sync_high_uid, sync_complete,
                    sync_needs_repair, highest_modseq
             FROM mail_folders WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let mut stmt = conn.prepare(
        "SELECT uid FROM mail_messages WHERE account_id = ?1 AND folder = ?2 ORDER BY uid",
    )?;
    let cached_uids = stmt
        .query_map(params![account_id, folder], |row| row.get::<_, u32>(0))?
        .collect::<SqlResult<Vec<_>>>()?;
    let mut state = FolderSyncState {
        cached_uids,
        ..FolderSyncState::default()
    };
    if let Some((uid_validity, low, high, complete, needs_repair, modseq)) = row {
        state.uid_validity = uid_validity;
        state.low = low;
        state.high = high;
        state.complete = complete != 0;
        state.needs_repair = needs_repair != 0;
        state.highest_modseq = modseq.map(|value| value.max(0) as u64);
    }
    Ok(state)
}

/// Drop a folder's cached messages and watermarks (UIDVALIDITY changed).
pub(super) fn reset_folder_cache(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
        params![account_id, folder],
    )?;
    conn.execute(
        "UPDATE mail_folders
         SET sync_low_uid = NULL, sync_high_uid = NULL, sync_complete = 0,
             sync_needs_repair = 0, highest_modseq = NULL
         WHERE account_id = ?1 AND name = ?2",
        params![account_id, folder],
    )?;
    Ok(())
}

/// Remove cached rows below `cut` and move the span's low end with them. The
/// dropped history is intentionally outside the retention policy, so the span
/// is marked complete (no backfill below it) and `high` is raised to at least
/// `cut - 1` so a catch-up never refetches what was just pruned.
pub(super) fn apply_prune_cut(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    cut: u32,
) -> SqlResult<()> {
    let deleted = conn.execute(
        "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid < ?3",
        params![account_id, folder, cut],
    )?;
    conn.execute(
        "UPDATE mail_folders
         SET sync_low_uid = MAX(COALESCE(sync_low_uid, 0), ?3),
             sync_high_uid = MAX(sync_high_uid, ?3 - 1),
             sync_complete = CASE WHEN ?4 > 0 OR COALESCE(sync_low_uid, 0) < ?3
                                  THEN 1 ELSE sync_complete END
         WHERE account_id = ?1 AND name = ?2 AND sync_high_uid IS NOT NULL",
        params![account_id, folder, cut, deleted as i64],
    )?;
    Ok(())
}

/// Record a per-folder sync failure so the UI can show it.
pub(super) fn record_folder_error(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    error: &str,
) -> SqlResult<()> {
    conn.execute(
        "UPDATE mail_folders SET last_error = ?3 WHERE account_id = ?1 AND name = ?2",
        params![account_id, folder, error],
    )?;
    Ok(())
}

pub(super) struct AppliedStep {
    pub flags_updated: usize,
    pub folder: Option<MailFolder>,
}

/// Write one step's result: messages, deletions, flag changes and the new
/// watermark, then prune — all in one transaction.
/// Milliseconds since the epoch (flag-change ordering).
pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Apply one sync step. `started_ms` is when the step began talking to the
/// server: flags changed locally after that are newer than what it read.
pub(super) fn apply_folder_step(
    conn: &Connection,
    account_id: &str,
    outcome: &FolderStepOutcome,
    cache: &MailCacheSettings,
    started_ms: i64,
) -> SqlResult<AppliedStep> {
    let tx = conn.unchecked_transaction()?;
    let folder_name = outcome.folder.name.as_str();
    if outcome.uid_validity_reset {
        reset_folder_cache(&tx, account_id, folder_name)?;
    }
    upsert_folder(&tx, &outcome.folder)?;
    for message in &outcome.messages {
        upsert_message(&tx, message)?;
    }
    if !outcome.vanished.is_empty() {
        let mut stmt = tx.prepare(
            "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        )?;
        for uid in &outcome.vanished {
            stmt.execute(params![account_id, folder_name, uid])?;
        }
    }
    let mut flags_updated = 0usize;
    if !outcome.flag_updates.is_empty() {
        let mut stmt = tx.prepare(
            "UPDATE mail_messages SET flags_json = ?4, updated_at = ?5
             WHERE account_id = ?1 AND folder = ?2 AND uid = ?3 AND flags_json != ?4
               AND COALESCE(flags_local_at, 0) < ?6",
        )?;
        let now = now_ts();
        for (uid, flags) in &outcome.flag_updates {
            let flags_json = serde_json::to_string(flags).unwrap_or_else(|_| "[]".into());
            flags_updated += stmt.execute(params![
                account_id,
                folder_name,
                uid,
                flags_json,
                now,
                started_ms
            ])?;
        }
    }
    let wm = outcome.watermark;
    // Only an initial sync or a backfill may lower the span's low end or clear
    // completeness; every other step keeps what a prune in an earlier step of
    // the same batch already moved (the span never grows downward silently).
    let can_lower = matches!(outcome.mode, MailSyncMode::Initial | MailSyncMode::Backfill);
    tx.execute(
        "UPDATE mail_folders
         SET sync_low_uid = CASE WHEN ?10 = 1 OR sync_low_uid IS NULL THEN ?3
                                 ELSE MAX(sync_low_uid, COALESCE(?3, 0)) END,
             sync_high_uid = CASE WHEN ?4 IS NULL THEN sync_high_uid
                                  ELSE MAX(COALESCE(sync_high_uid, 0), ?4) END,
             sync_complete = CASE WHEN ?10 = 1 THEN ?5 ELSE MAX(sync_complete, ?5) END,
             sync_needs_repair = ?6, last_error = NULL,
             highest_modseq = COALESCE(?7, highest_modseq),
             last_reconcile_at = CASE WHEN ?8 = 1 THEN ?9 ELSE last_reconcile_at END
         WHERE account_id = ?1 AND name = ?2",
        params![
            account_id,
            folder_name,
            wm.low,
            wm.high,
            wm.complete as i64,
            wm.needs_repair as i64,
            outcome.highest_modseq.map(|value| value as i64),
            outcome.reconciled as i64,
            now_ts(),
            can_lower as i64,
        ],
    )?;
    prune_mail_cache(&tx, account_id, folder_name, cache)?;
    if !outcome.messages.is_empty() || !outcome.vanished.is_empty() {
        reindex_cached_contacts(&tx, account_id)?;
    }
    tx.commit()?;
    let folder = super::list_cached_folders(conn, account_id)?
        .into_iter()
        .find(|folder| folder.name == folder_name);
    Ok(AppliedStep {
        flags_updated,
        folder,
    })
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct FillPlan {
    /// UIDs to fetch now, ascending (the newest `limit` missing ones).
    pub fetch: Vec<u32>,
    /// Cached UIDs in range that the server no longer has.
    pub vanished: Vec<u32>,
    /// Missing UIDs left for later steps.
    pub remaining: usize,
    pub server_max: Option<u32>,
}

/// Plan filling `[lo, hi]` (hi = None means open-ended) from the server UID
/// set: fetch what is missing (newest first), report what vanished.
pub(super) fn plan_fill_range(
    server: &[u32],
    cached: &[u32],
    lo: u32,
    hi: Option<u32>,
    limit: usize,
) -> FillPlan {
    let in_range = |uid: &u32| *uid >= lo && hi.is_none_or(|hi| *uid <= hi);
    let server: Vec<u32> = server.iter().copied().filter(in_range).collect();
    let server_set: HashSet<u32> = server.iter().copied().collect();
    let cached_set: HashSet<u32> = cached.iter().copied().filter(in_range).collect();
    let mut missing: Vec<u32> = server
        .iter()
        .copied()
        .filter(|uid| !cached_set.contains(uid))
        .collect();
    missing.sort_unstable();
    missing.dedup();
    let take = limit.max(1).min(missing.len());
    let mut fetch = missing[missing.len() - take..].to_vec();
    fetch.sort_unstable();
    let mut vanished: Vec<u32> = cached_set
        .iter()
        .copied()
        .filter(|uid| !server_set.contains(uid))
        .collect();
    vanished.sort_unstable();
    FillPlan {
        remaining: missing.len() - take,
        fetch,
        vanished,
        server_max: server.iter().copied().max(),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct BackfillPlan {
    pub fetch: Vec<u32>,
    pub new_low: Option<u32>,
    pub complete: bool,
}

/// Plan the next older block below the span. `older` are server UIDs below
/// `low` found by a search whose window reached UID 1 iff `reached_start`.
pub(super) fn plan_backfill(
    older: &[u32],
    cached: &[u32],
    reached_start: bool,
    limit: usize,
) -> BackfillPlan {
    let mut older = older.to_vec();
    older.sort_unstable();
    older.dedup();
    let take = limit.max(1).min(older.len());
    let block = &older[older.len() - take..];
    let cached_set: HashSet<u32> = cached.iter().copied().collect();
    BackfillPlan {
        fetch: block
            .iter()
            .copied()
            .filter(|uid| !cached_set.contains(uid))
            .collect(),
        new_low: block.first().copied(),
        complete: reached_start && older.len() <= take,
    }
}

/// Lower bound of the newest `window` cached UIDs (quiet reconcile range).
pub(super) fn recent_window_start(cached: &[u32], low: u32, window: usize) -> u32 {
    if cached.len() > window {
        cached[cached.len() - window].max(low)
    } else {
        low
    }
}

pub(super) fn count_unseen(messages: &[MailMessageCached]) -> usize {
    messages
        .iter()
        .filter(|message| {
            !message
                .header
                .flags
                .iter()
                .any(|flag| flag.eq_ignore_ascii_case("\\Seen"))
        })
        .count()
}

// ---------------------------------------------------------------------------
// IMAP helpers
// ---------------------------------------------------------------------------

pub(super) struct RemoteMailbox {
    pub exists: u32,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub flags: Vec<String>,
    pub highest_modseq: Option<u64>,
}

/// Quote a mailbox name for a raw IMAP command.
pub(super) fn quote_imap_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        if ch != '\r' && ch != '\n' {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

/// Parse the untagged data of an `EXAMINE ... (CONDSTORE)` response.
pub(super) fn parse_examine_response(raw: &str) -> RemoteMailbox {
    let mut mailbox = RemoteMailbox {
        exists: 0,
        uid_validity: None,
        uid_next: None,
        flags: Vec::new(),
        highest_modseq: None,
    };
    for line in raw.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("* ") else {
            continue;
        };
        let upper = rest.to_ascii_uppercase();
        if let Some(count) = upper.strip_suffix(" EXISTS") {
            mailbox.exists = count.trim().parse().unwrap_or(mailbox.exists);
        } else if upper.starts_with("FLAGS (") {
            if let (Some(open), Some(close)) = (rest.find('('), rest.rfind(')')) {
                mailbox.flags = rest[open + 1..close]
                    .split_whitespace()
                    .map(ToOwned::to_owned)
                    .collect();
            }
        } else if upper.starts_with("OK [") {
            let code = &rest[4..rest.find(']').unwrap_or(rest.len())];
            let mut parts = code.split_whitespace();
            let key = parts.next().unwrap_or("").to_ascii_uppercase();
            let value = parts.next().unwrap_or("");
            match key.as_str() {
                "UIDVALIDITY" => mailbox.uid_validity = value.parse().ok(),
                "UIDNEXT" => mailbox.uid_next = value.parse().ok(),
                "HIGHESTMODSEQ" => mailbox.highest_modseq = value.parse().ok(),
                _ => {}
            }
        }
    }
    mailbox
}

pub(super) fn imap_has_capability<T: Read + Write>(
    session: &mut imap::Session<T>,
    name: &str,
) -> bool {
    session
        .capabilities()
        .map(|caps| caps.has_str(name))
        .unwrap_or(false)
}

/// EXAMINE the folder. With CONDSTORE the raw form is used so HIGHESTMODSEQ
/// (which the `imap` 2.4 Mailbox type drops) is available.
fn imap_examine<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    condstore: bool,
) -> Result<RemoteMailbox, String> {
    if condstore {
        let command = format!("EXAMINE {} (CONDSTORE)", quote_imap_string(folder));
        let raw = session
            .run_command_and_read_response(&command)
            .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
        return Ok(parse_examine_response(&String::from_utf8_lossy(&raw)));
    }
    let mailbox = session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    Ok(RemoteMailbox {
        exists: mailbox.exists,
        uid_validity: mailbox.uid_validity,
        uid_next: mailbox.uid_next,
        flags: mailbox.flags.iter().map(|flag| flag.to_string()).collect(),
        highest_modseq: None,
    })
}

/// `UID SEARCH UID lo:hi` (hi None = `*`), sorted and clamped to the range —
/// `n:*` matches the highest UID even when it is below `n`.
fn imap_search_uid_range<T: Read + Write>(
    session: &mut imap::Session<T>,
    lo: u32,
    hi: Option<u32>,
) -> Result<Vec<u32>, String> {
    let lo = lo.max(1);
    if hi.is_some_and(|hi| hi < lo) {
        return Ok(Vec::new());
    }
    let query = match hi {
        Some(hi) => format!("UID {lo}:{hi}"),
        None => format!("UID {lo}:*"),
    };
    let mut uids: Vec<u32> = session
        .uid_search(&query)
        .map_err(|e| format!("IMAP UID SEARCH {query} failed: {e}"))?
        .into_iter()
        .filter(|uid| *uid >= lo && hi.is_none_or(|hi| *uid <= hi))
        .collect();
    uids.sort_unstable();
    uids.dedup();
    Ok(uids)
}

/// Server UIDs just below `below`, widening a window until at least `need`
/// are found or UID 1 is reached.
fn imap_search_older<T: Read + Write>(
    session: &mut imap::Session<T>,
    below: u32,
    need: usize,
) -> Result<(Vec<u32>, bool), String> {
    if below <= 1 {
        return Ok((Vec::new(), true));
    }
    let top = below - 1;
    let mut window = (need.saturating_mul(4).max(need + 64).min(50_000) as u32).max(1);
    loop {
        let start = top.saturating_sub(window - 1).max(1);
        let uids = imap_search_uid_range(session, start, Some(top))?;
        if uids.len() >= need || start == 1 {
            return Ok((uids, start == 1));
        }
        window = window.saturating_mul(4);
    }
}

fn imap_fetch_flags<T: Read + Write>(
    session: &mut imap::Session<T>,
    uid_set: &str,
    changed_since: Option<u64>,
) -> Result<Vec<(u32, Vec<String>)>, String> {
    let query = match changed_since {
        Some(modseq) => format!("(UID FLAGS) (CHANGEDSINCE {modseq})"),
        None => "(UID FLAGS)".to_string(),
    };
    let fetches = session
        .uid_fetch(uid_set, &query)
        .map_err(|e| format!("IMAP UID FETCH FLAGS failed: {e}"))?;
    Ok(fetches
        .iter()
        .filter_map(|fetch| fetch.uid.map(|uid| (uid, fetch_flag_strings(fetch))))
        .collect())
}

fn imap_fetch_flags_for_uids<T: Read + Write>(
    session: &mut imap::Session<T>,
    uids: &[u32],
) -> Result<Vec<(u32, Vec<String>)>, String> {
    let mut updates = Vec::new();
    for chunk in uids.chunks(FLAG_FETCH_CHUNK) {
        updates.extend(imap_fetch_flags(session, &uid_set_string(chunk), None)?);
    }
    Ok(updates)
}

fn fetch_desc(mut messages: Vec<MailMessageCached>) -> Vec<MailMessageCached> {
    messages.sort_by(|a, b| b.header.uid.cmp(&a.header.uid));
    messages
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

pub(super) struct StepParams {
    pub request: MailSyncRequestMode,
    pub limit: usize,
    pub include_bodies: bool,
    pub condstore: bool,
}

/// Run one bounded sync step for `folder` against the stored `state`.
pub(super) fn imap_sync_folder_step<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    state: &FolderSyncState,
    params: &StepParams,
) -> Result<FolderStepOutcome, String> {
    let remote = imap_examine(session, folder, params.condstore)?;
    let unread = imap_unread_count(session, folder);
    let account_id = &account.config.session_id;
    let folder_info = MailFolder {
        account_id: account_id.clone(),
        name: folder.to_string(),
        display_name: decode_imap_modified_utf7(folder),
        flags: remote.flags.clone(),
        uid_validity: remote.uid_validity,
        uid_next: remote.uid_next,
        total: Some(remote.exists),
        unread,
        updated_at: now_ts(),
        ..MailFolder::default()
    };
    let limit = params.limit.clamp(1, 2000);

    let uid_validity_reset = matches!(
        (state.uid_validity, remote.uid_validity),
        (Some(old), Some(new)) if old != new
    );
    let mut state = if uid_validity_reset {
        FolderSyncState {
            uid_validity: remote.uid_validity,
            ..FolderSyncState::default()
        }
    } else {
        state.clone()
    };

    let mut outcome = FolderStepOutcome {
        folder: folder_info,
        mode: MailSyncMode::Catchup,
        messages: Vec::new(),
        vanished: Vec::new(),
        flag_updates: Vec::new(),
        watermark: Watermark::default(),
        highest_modseq: None,
        reconciled: false,
        uid_validity_reset,
        remaining: 0,
        more: false,
        new_unseen: 0,
    };

    // Never synced (or reset): take the newest page and start the span there.
    if state.high.is_none() && state.cached_uids.is_empty() {
        let (page, has_more) =
            imap_page_uids_newest_first(session, remote.uid_next, remote.exists, 0, limit)?;
        let messages =
            imap_fetch_messages_for_uids(session, account, folder, &page, params.include_bodies)?;
        let empty_high = remote
            .uid_next
            .map(|next| next.saturating_sub(1))
            .unwrap_or(0);
        outcome.mode = MailSyncMode::Initial;
        outcome.watermark = Watermark {
            low: Some(
                page.first()
                    .copied()
                    .unwrap_or(empty_high.saturating_add(1)),
            ),
            high: Some(page.last().copied().unwrap_or(empty_high)),
            complete: !has_more,
            needs_repair: false,
        };
        outcome.highest_modseq = remote.highest_modseq;
        outcome.messages = fetch_desc(messages);
        return Ok(outcome);
    }

    // Pre-watermark cache: adopt its span, verify it against the server.
    if state.high.is_none() {
        state.low = state.cached_uids.first().copied();
        state.high = state.cached_uids.last().copied();
        state.complete = false;
        state.needs_repair = true;
    }
    let low = state.low.unwrap_or(1);
    let high = state.high.unwrap_or(0);
    outcome.watermark = Watermark {
        low: Some(low),
        high: Some(high),
        complete: state.complete,
        needs_repair: state.needs_repair,
    };

    if state.needs_repair {
        let server = imap_search_uid_range(session, low, Some(high))?;
        let plan = plan_fill_range(&server, &state.cached_uids, low, Some(high), limit);
        let messages = imap_fetch_messages_for_uids(
            session,
            account,
            folder,
            &plan.fetch,
            params.include_bodies,
        )?;
        outcome.mode = MailSyncMode::Repair;
        outcome.messages = fetch_desc(messages);
        outcome.vanished = plan.vanished;
        outcome.remaining = plan.remaining;
        outcome.watermark.needs_repair = plan.remaining > 0;
        // Repair only verifies the old span; the caller continues with catch-up.
        outcome.more = true;
        return Ok(outcome);
    }

    match params.request {
        MailSyncRequestMode::Auto | MailSyncRequestMode::Catchup => {
            let start = high.saturating_add(1);
            let server = imap_search_uid_range(session, start, None)?;
            let plan = plan_fill_range(&server, &state.cached_uids, start, None, limit);
            let messages = imap_fetch_messages_for_uids(
                session,
                account,
                folder,
                &plan.fetch,
                params.include_bodies,
            )?;
            outcome.mode = MailSyncMode::Catchup;
            outcome.new_unseen = count_unseen(&messages);
            outcome.messages = fetch_desc(messages);
            outcome.vanished = plan.vanished;
            outcome.remaining = plan.remaining;
            outcome.more = plan.remaining > 0;
            if plan.remaining == 0 {
                if let Some(max) = plan.server_max {
                    outcome.watermark.high = Some(max.max(high));
                }
            }
        }
        MailSyncRequestMode::Backfill => {
            outcome.mode = MailSyncMode::Backfill;
            if state.complete {
                return Ok(outcome);
            }
            let (older, reached_start) = imap_search_older(session, low, limit)?;
            let plan = plan_backfill(&older, &state.cached_uids, reached_start, limit);
            let messages = imap_fetch_messages_for_uids(
                session,
                account,
                folder,
                &plan.fetch,
                params.include_bodies,
            )?;
            outcome.messages = fetch_desc(messages);
            if let Some(new_low) = plan.new_low {
                outcome.watermark.low = Some(new_low.min(low));
            }
            outcome.watermark.complete = plan.complete;
            outcome.more = !plan.complete;
        }
        MailSyncRequestMode::Reconcile | MailSyncRequestMode::ReconcileFull => {
            let full = params.request == MailSyncRequestMode::ReconcileFull;
            outcome.mode = if full {
                MailSyncMode::ReconcileFull
            } else {
                MailSyncMode::Reconcile
            };
            if high < low {
                outcome.reconciled = true;
                outcome.highest_modseq = remote.highest_modseq;
                return Ok(outcome);
            }
            let lo = if full {
                low
            } else {
                recent_window_start(&state.cached_uids, low, FLAG_RECONCILE_WINDOW)
            };
            let server = imap_search_uid_range(session, lo, Some(high))?;
            let plan = plan_fill_range(&server, &state.cached_uids, lo, Some(high), limit);
            let messages = imap_fetch_messages_for_uids(
                session,
                account,
                folder,
                &plan.fetch,
                params.include_bodies,
            )?;
            let fetched: HashSet<u32> = plan.fetch.iter().copied().collect();
            outcome.messages = fetch_desc(messages);
            outcome.vanished = plan.vanished;
            outcome.remaining = plan.remaining;
            outcome.more = plan.remaining > 0;

            let unchanged = params.condstore
                && remote.highest_modseq.is_some()
                && remote.highest_modseq == state.highest_modseq;
            if unchanged {
                outcome.reconciled = true;
            } else if let (true, Some(since)) = (params.condstore, state.highest_modseq) {
                // Only changed messages come back; covers the whole span.
                outcome.flag_updates =
                    imap_fetch_flags(session, &format!("{low}:{high}"), Some(since))?
                        .into_iter()
                        .filter(|(uid, _)| !fetched.contains(uid))
                        .collect();
                outcome.highest_modseq = remote.highest_modseq;
                outcome.reconciled = true;
            } else {
                let targets: Vec<u32> = server
                    .iter()
                    .copied()
                    .filter(|uid| !fetched.contains(uid))
                    .collect();
                outcome.flag_updates = imap_fetch_flags_for_uids(session, &targets)?;
                if full {
                    outcome.highest_modseq = remote.highest_modseq;
                    outcome.reconciled = true;
                }
            }
        }
    }
    Ok(outcome)
}

/// In-memory state after `outcome` is applied (for multi-step batches that
/// run inside one IMAP session before anything is written).
pub(super) fn advance_state(
    state: &FolderSyncState,
    outcome: &FolderStepOutcome,
) -> FolderSyncState {
    let mut cached: HashSet<u32> = if outcome.uid_validity_reset {
        HashSet::new()
    } else {
        state.cached_uids.iter().copied().collect()
    };
    for message in &outcome.messages {
        cached.insert(message.header.uid);
    }
    for uid in &outcome.vanished {
        cached.remove(uid);
    }
    let mut cached_uids: Vec<u32> = cached.into_iter().collect();
    cached_uids.sort_unstable();
    let wm = outcome.watermark;
    FolderSyncState {
        uid_validity: outcome.folder.uid_validity.or(state.uid_validity),
        low: wm.low,
        high: wm.high,
        complete: wm.complete,
        needs_repair: wm.needs_repair,
        highest_modseq: outcome.highest_modseq.or(state.highest_modseq),
        cached_uids,
    }
}

/// Build the IPC result from a step outcome after it was applied.
pub(super) fn step_result(
    account_id: &str,
    outcome: FolderStepOutcome,
    applied: Option<AppliedStep>,
) -> MailFolderSyncResult {
    let (flags_updated, folder) = match applied {
        Some(applied) => (applied.flags_updated, applied.folder),
        None => (outcome.flag_updates.len(), None),
    };
    let mut folder = folder.unwrap_or_else(|| outcome.folder.clone());
    if folder.sync_high_uid.is_none() {
        folder.sync_low_uid = outcome.watermark.low;
        folder.sync_high_uid = outcome.watermark.high;
        folder.sync_complete = outcome.watermark.complete;
    }
    let messages: Vec<MailMessageHeader> =
        outcome.messages.iter().map(|m| m.header.clone()).collect();
    MailFolderSyncResult {
        account_id: account_id.to_string(),
        sync_complete: folder.sync_complete,
        folder,
        mode: outcome.mode,
        fetched: messages.len(),
        messages,
        new_unseen: outcome.new_unseen,
        vanished: outcome.vanished.len(),
        flags_updated,
        remaining_new: outcome.remaining,
        more: outcome.more,
        uid_validity_reset: outcome.uid_validity_reset,
        synced_at: now_ts(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_plan_fetches_newest_missing_first_and_reports_vanished() {
        let server: Vec<u32> = (1..=10).chain(20..=25).collect();
        let cached = vec![1, 2, 3, 9, 10, 11, 25];
        let plan = plan_fill_range(&server, &cached, 1, None, 4);
        assert_eq!(plan.fetch, vec![21, 22, 23, 24]);
        assert_eq!(plan.remaining, 1 + 5); // 20 and 4..=8
        assert_eq!(plan.vanished, vec![11]);
        assert_eq!(plan.server_max, Some(25));
    }

    #[test]
    fn fill_plan_clamps_open_range_and_star_semantics() {
        // `UID 51:*` on a server whose max UID is 50 returns 50.
        let plan = plan_fill_range(&[50], &[], 51, None, 10);
        assert!(plan.fetch.is_empty());
        assert_eq!(plan.server_max, None);
        let plan = plan_fill_range(&[1, 5, 9], &[1, 5, 9, 12], 5, Some(9), 10);
        assert!(plan.fetch.is_empty());
        assert!(plan.vanished.is_empty(), "12 is outside the range");
    }

    /// Simulates repeated catch-up steps after a long absence (R1): all new
    /// UIDs end up cached regardless of the batch size.
    #[test]
    fn repeated_catchup_converges_without_gaps() {
        let mut cached: Vec<u32> = (1..=100).collect();
        let high = 100u32;
        let server: Vec<u32> = (1..=100).chain(101..=320).collect();
        let mut steps = 0;
        loop {
            let plan = plan_fill_range(&server, &cached, high + 1, None, 50);
            cached.extend(&plan.fetch);
            cached.sort_unstable();
            steps += 1;
            if plan.remaining == 0 {
                break;
            }
            // An interrupted step (nothing written) is recomputed next time.
            if steps == 2 {
                let again = plan_fill_range(&server, &cached, high + 1, None, 50);
                assert_eq!(again.remaining + again.fetch.len(), plan.remaining);
            }
        }
        assert_eq!(cached, server);
        assert_eq!(steps, 5);
    }

    #[test]
    fn backfill_walks_down_and_completes() {
        let server: Vec<u32> = (1..=130).collect();
        let mut cached: Vec<u32> = (101..=130).collect();
        let mut low = 101u32;
        let mut complete = false;
        let mut rounds = 0;
        while !complete {
            let older: Vec<u32> = server.iter().copied().filter(|uid| *uid < low).collect();
            let plan = plan_backfill(&older, &cached, true, 40);
            cached.extend(&plan.fetch);
            low = plan.new_low.unwrap_or(low);
            complete = plan.complete;
            rounds += 1;
        }
        cached.sort_unstable();
        assert_eq!(cached, server);
        assert_eq!(low, 1);
        assert_eq!(rounds, 3);
        // An empty search below the span completes immediately.
        let plan = plan_backfill(&[], &cached, true, 40);
        assert!(plan.complete && plan.fetch.is_empty() && plan.new_low.is_none());
        // A window that did not reach UID 1 cannot complete.
        assert!(!plan_backfill(&[5, 6], &[], false, 40).complete);
    }

    #[test]
    fn recent_window_start_uses_newest_cached_uids() {
        let cached: Vec<u32> = (1..=10).collect();
        assert_eq!(recent_window_start(&cached, 1, 3), 8);
        assert_eq!(recent_window_start(&cached, 1, 30), 1);
        assert_eq!(recent_window_start(&cached, 9, 3), 9);
    }

    #[test]
    fn parses_condstore_examine_response() {
        let raw = "* FLAGS (\\Answered \\Flagged \\Seen $Junk)\r\n\
                   * OK [PERMANENTFLAGS ()] Read-only\r\n\
                   * 172 EXISTS\r\n\
                   * 0 RECENT\r\n\
                   * OK [UIDVALIDITY 3857529045] UIDs valid\r\n\
                   * OK [UIDNEXT 4392] Predicted next UID\r\n\
                   * OK [HIGHESTMODSEQ 715194045007] Highest\r\n\
                   A5 OK [READ-ONLY] EXAMINE completed\r\n";
        let parsed = parse_examine_response(raw);
        assert_eq!(parsed.exists, 172);
        assert_eq!(parsed.uid_validity, Some(3_857_529_045));
        assert_eq!(parsed.uid_next, Some(4392));
        assert_eq!(parsed.highest_modseq, Some(715_194_045_007));
        assert_eq!(
            parsed.flags,
            vec!["\\Answered", "\\Flagged", "\\Seen", "$Junk"]
        );
    }

    // -----------------------------------------------------------------
    // End-to-end steps against the in-process fake IMAP server + SQLite.
    // -----------------------------------------------------------------

    use super::super::fake_imap::FakeImap;
    use super::super::{MailAccountConfig, init_mail_tables};

    fn account(cache: serde_json::Value) -> ResolvedMailAccount {
        let config: MailAccountConfig = serde_json::from_value(serde_json::json!({
            "sessionId": "acct",
            "emailAddress": "user@example.com",
            "imap": { "host": "127.0.0.1", "port": 1, "security": "None" },
            "smtp": { "host": "127.0.0.1", "port": 1, "security": "None" },
            "cache": cache,
        }))
        .expect("config");
        ResolvedMailAccount {
            config,
            auth_mode: super::super::MailAuthMode::Password,
            network_settings: None,
            imap_username: "user".into(),
            imap_password: "pass".into(),
            smtp_username: "user".into(),
            smtp_password: "pass".into(),
        }
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        conn
    }

    fn step(
        fake: &FakeImap,
        conn: &Connection,
        account: &ResolvedMailAccount,
        request: MailSyncRequestMode,
        limit: usize,
    ) -> MailFolderSyncResult {
        let state = load_folder_sync_state(conn, "acct", "INBOX").unwrap();
        let mut session = fake.session();
        let condstore = imap_has_capability(&mut session, "CONDSTORE");
        let outcome = imap_sync_folder_step(
            &mut session,
            account,
            "INBOX",
            &state,
            &StepParams {
                request,
                limit,
                include_bodies: false,
                condstore,
            },
        )
        .expect("step");
        let applied =
            apply_folder_step(conn, "acct", &outcome, &account.config.cache, now_ms()).unwrap();
        step_result("acct", outcome, Some(applied))
    }

    /// Repeat a request until the backend reports no more work.
    fn drain(
        fake: &FakeImap,
        conn: &Connection,
        account: &ResolvedMailAccount,
        request: MailSyncRequestMode,
        limit: usize,
    ) -> (usize, Vec<MailSyncMode>) {
        let mut new_unseen = 0;
        let mut modes = Vec::new();
        for _ in 0..200 {
            let result = step(fake, conn, account, request, limit);
            new_unseen += result.new_unseen;
            modes.push(result.mode);
            if !result.more {
                return (new_unseen, modes);
            }
        }
        panic!("sync did not converge: {modes:?}");
    }

    fn cached(conn: &Connection) -> Vec<u32> {
        load_folder_sync_state(conn, "acct", "INBOX")
            .unwrap()
            .cached_uids
    }

    fn cached_flags(conn: &Connection, uid: u32) -> Vec<String> {
        let json: String = conn
            .query_row(
                "SELECT flags_json FROM mail_messages WHERE folder = 'INBOX' AND uid = ?1",
                params![uid],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&json).unwrap()
    }

    /// AC-01/AC-02 (R1): more new mail than one batch after an absence is
    /// fully fetched, and only genuinely new mail counts as new.
    #[test]
    fn catchup_after_absence_fetches_every_new_message() {
        for condstore in [false, true] {
            let fake = FakeImap::start(condstore);
            let conn = db();
            let account = account(serde_json::json!({}));
            fake.deliver("INBOX", 100, "old");
            let first = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
            assert_eq!(first.mode, MailSyncMode::Initial);
            assert_eq!(first.new_unseen, 0, "initial sync is not new mail");
            assert_eq!(cached(&conn), (51..=100).collect::<Vec<_>>());

            // Tab closed; 120 arrive (and a few UIDs are burned elsewhere).
            fake.burn_uids("INBOX", 7);
            fake.deliver("INBOX", 120, "new");
            let (new_unseen, modes) = drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
            assert_eq!(new_unseen, 120);
            assert!(modes.iter().all(|mode| *mode == MailSyncMode::Catchup));
            let server = fake.uids("INBOX");
            let expected: Vec<u32> = server.iter().copied().filter(|uid| *uid >= 51).collect();
            assert_eq!(cached(&conn), expected, "no gap after catch-up");

            // Nothing new: a further step is a no-op.
            let idle = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
            assert_eq!((idle.fetched, idle.new_unseen, idle.more), (0, 0, false));
        }
    }

    /// TASK-18: List-Unsubscribe is parsed from the header fetch and cached.
    #[test]
    fn list_unsubscribe_is_cached_with_the_header() {
        let fake = FakeImap::start(false);
        let conn = db();
        let account = account(serde_json::json!({}));
        let raw = concat!(
            "From: News <news@example.com>\r\n",
            "To: user@example.com\r\n",
            "Subject: Weekly\r\n",
            "Date: Tue, 14 Nov 2023 22:13:20 +0000\r\n",
            "Message-ID: <weekly@example.com>\r\n",
            "List-Unsubscribe: <mailto:leave@example.com>, <https://example.com/u>\r\n",
            "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n",
            "\r\nBody\r\n"
        );
        fake.deliver_raw("INBOX", raw.as_bytes().to_vec());
        fake.deliver("INBOX", 1, "plain");
        step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        let rows = super::super::list_cached_messages(&conn, "acct", "INBOX", 10, 0).unwrap();
        let weekly = rows.iter().find(|row| row.subject == "Weekly").unwrap();
        let list = weekly.list_unsubscribe.clone().expect("list header cached");
        assert!(list.one_click);
        assert_eq!(
            list.uris,
            vec!["mailto:leave@example.com", "https://example.com/u"]
        );
        let plain = rows.iter().find(|row| row.subject != "Weekly").unwrap();
        assert!(plain.list_unsubscribe.is_none());
    }

    /// AC-07/AC-12: backfill walks older history down to UID 1.
    #[test]
    fn backfill_reaches_the_oldest_message() {
        let fake = FakeImap::start(false);
        let conn = db();
        let account = account(serde_json::json!({}));
        fake.deliver("INBOX", 130, "msg");
        let first = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 40);
        assert!(!first.sync_complete);
        let (new_unseen, _) = drain(&fake, &conn, &account, MailSyncRequestMode::Backfill, 40);
        assert_eq!(new_unseen, 0, "history is not new mail");
        assert_eq!(cached(&conn), fake.uids("INBOX"));
        let folder = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
        assert!(folder.complete);
        assert_eq!(folder.low, Some(1));
    }

    /// AC-11: a cache written by the old newest-N logic has a hole; the first
    /// sync after upgrade repairs it without reporting the hole as new mail.
    #[test]
    fn legacy_cache_gap_is_repaired() {
        let fake = FakeImap::start(false);
        let conn = db();
        let account = account(serde_json::json!({}));
        fake.deliver("INBOX", 140, "msg");
        // Old client cached 1..=40 and 91..=140 (41..=90 missing), no watermark.
        let mut session = fake.session();
        let legacy: Vec<u32> = (1..=40).chain(91..=140).collect();
        let messages =
            imap_fetch_messages_for_uids(&mut session, &account, "INBOX", &legacy, false).unwrap();
        upsert_folder(
            &conn,
            &MailFolder {
                account_id: "acct".into(),
                name: "INBOX".into(),
                uid_validity: Some(1000),
                ..MailFolder::default()
            },
        )
        .unwrap();
        for message in &messages {
            upsert_message(&conn, message).unwrap();
        }
        fake.deliver("INBOX", 20, "after-upgrade");
        let (new_unseen, modes) = drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 30);
        assert_eq!(modes.first(), Some(&MailSyncMode::Repair));
        assert!(modes.contains(&MailSyncMode::Catchup));
        assert_eq!(new_unseen, 20, "only mail after the old max is new");
        assert_eq!(cached(&conn), fake.uids("INBOX"));
    }

    /// A reconcile that read the server before a local flag change (tagging
    /// while a background sync runs) must not undo that change; one that
    /// started afterwards still applies another client's change.
    #[test]
    fn reconcile_does_not_undo_newer_local_flag_changes() {
        let fake = FakeImap::start(false);
        let conn = db();
        let account = account(serde_json::json!({}));
        let uids = fake.deliver("INBOX", 5, "msg");
        drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        let target = uids[2];

        // The reconcile reads the server (no keyword yet) ...
        let state = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
        let started = now_ms();
        let mut session = fake.session();
        let outcome = imap_sync_folder_step(
            &mut session,
            &account,
            "INBOX",
            &state,
            &StepParams {
                request: MailSyncRequestMode::ReconcileFull,
                limit: 50,
                include_bodies: false,
                condstore: false,
            },
        )
        .expect("step");
        // ... then the user tags the message (cache + server) ...
        std::thread::sleep(std::time::Duration::from_millis(5));
        super::super::update_cached_flags(
            &conn,
            "acct",
            "INBOX",
            &[target],
            &["$label1".into()],
            &[],
        )
        .unwrap();
        fake.set_flags("INBOX", target, &["$label1"]);
        // ... and the stale reconcile lands afterwards (it saw no keyword).
        let mut outcome = outcome;
        if !outcome.flag_updates.iter().any(|(uid, _)| *uid == target) {
            outcome.flag_updates.push((target, Vec::new()));
        }
        apply_folder_step(&conn, "acct", &outcome, &account.config.cache, started).unwrap();
        assert_eq!(cached_flags(&conn, target), vec!["$label1".to_string()]);

        // Another client clears it later: a fresh reconcile applies that.
        std::thread::sleep(std::time::Duration::from_millis(5));
        fake.set_flags("INBOX", target, &[]);
        step(
            &fake,
            &conn,
            &account,
            MailSyncRequestMode::ReconcileFull,
            50,
        );
        assert!(cached_flags(&conn, target).is_empty());
    }

    /// AC-04/AC-05 (R5/R6): server-side deletions and flag changes, including
    /// a flag set becoming empty (unread), reach the cache.
    #[test]
    fn reconcile_applies_deletions_and_flag_changes() {
        for condstore in [false, true] {
            let fake = FakeImap::start(condstore);
            let conn = db();
            let account = account(serde_json::json!({}));
            let uids = fake.deliver("INBOX", 30, "msg");
            fake.set_flags("INBOX", uids[5], &["\\Seen"]);
            drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
            // Establish the modseq baseline.
            step(
                &fake,
                &conn,
                &account,
                MailSyncRequestMode::ReconcileFull,
                50,
            );
            assert_eq!(cached_flags(&conn, uids[5]), vec!["\\Seen".to_string()]);

            fake.expunge("INBOX", &uids[0..3]);
            fake.set_flags("INBOX", uids[5], &[]);
            fake.set_flags("INBOX", uids[6], &["\\Flagged"]);
            let result = step(
                &fake,
                &conn,
                &account,
                MailSyncRequestMode::ReconcileFull,
                50,
            );
            assert_eq!(result.vanished, 3);
            assert_eq!(result.flags_updated, 2, "condstore={condstore}");
            assert_eq!(cached(&conn), fake.uids("INBOX"));
            assert!(cached_flags(&conn, uids[5]).is_empty(), "now unread");
            assert_eq!(cached_flags(&conn, uids[6]), vec!["\\Flagged".to_string()]);

            // An unchanged mailbox reconciles without touching rows.
            let again = step(
                &fake,
                &conn,
                &account,
                MailSyncRequestMode::ReconcileFull,
                50,
            );
            assert_eq!((again.vanished, again.flags_updated), (0, 0));
            if condstore {
                let log = fake.log();
                assert!(log.iter().any(|line| line.contains("CHANGEDSINCE")));
            }
        }
    }

    /// AC-08: a UIDVALIDITY change rebuilds the folder.
    #[test]
    fn uid_validity_change_rebuilds_the_folder() {
        let fake = FakeImap::start(false);
        let conn = db();
        let account = account(serde_json::json!({}));
        fake.deliver("INBOX", 10, "msg");
        drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        fake.reset_uid_validity("INBOX", 2000);
        let result = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        assert!(result.uid_validity_reset);
        assert_eq!(result.mode, MailSyncMode::Initial);
        assert_eq!(cached(&conn), fake.uids("INBOX"));
        let state = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
        assert_eq!(state.uid_validity, Some(2000));
    }

    /// AC-06 (R3): retention uses the arrival time, so a new message with an
    /// old `Date:` header survives; truly old mail is pruned and the span stays
    /// consistent (no refetch loop).
    #[test]
    fn retention_uses_arrival_time_and_keeps_span_consistent() {
        let fake = FakeImap::start(false);
        let conn = db();
        let account = account(serde_json::json!({ "headerRetentionDays": 30 }));
        let now = now_ts();
        let old = fake.deliver_dated(
            "INBOX",
            5,
            "old",
            now - 90 * 86_400,
            "Mon, 1 Jan 2018 00:00:00 +0000",
        );
        let backdated = fake.deliver_dated(
            "INBOX",
            1,
            "backdated",
            now,
            "Mon, 1 Jan 2018 00:00:00 +0000",
        );
        drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        assert_eq!(
            cached(&conn),
            backdated,
            "old arrivals pruned, back-dated arrival kept"
        );
        let state = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
        assert!(state.complete, "retention boundary ends backfill");
        assert!(state.low.unwrap() > *old.last().unwrap());
        let again = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        assert_eq!(again.fetched, 0, "pruned history is not refetched");
    }

    /// A per-folder header cap converges instead of refetching pruned rows.
    #[test]
    fn header_limit_converges() {
        let fake = FakeImap::start(false);
        let conn = db();
        let account = account(serde_json::json!({ "headerLimitPerFolder": 25 }));
        fake.deliver("INBOX", 10, "a");
        drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 10);
        fake.deliver("INBOX", 100, "b");
        drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 10);
        let server = fake.uids("INBOX");
        assert_eq!(cached(&conn), server[server.len() - 25..].to_vec());
        let again = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 10);
        assert_eq!(again.fetched, 0);
    }

    #[test]
    fn migration_is_idempotent_and_keeps_rows() {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        conn.execute_batch("PRAGMA user_version = 0;").unwrap();
        migrate_mail_tables(&conn).unwrap();
        migrate_mail_tables(&conn).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MAIL_SCHEMA_VERSION);
    }

    #[test]
    fn quotes_mailbox_names() {
        assert_eq!(quote_imap_string("INBOX"), "\"INBOX\"");
        assert_eq!(quote_imap_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(quote_imap_string("x\r\ny"), "\"xy\"");
    }
}
