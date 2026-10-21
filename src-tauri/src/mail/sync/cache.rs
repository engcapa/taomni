use super::model::AppliedStep;
use super::model::FolderStepOutcome;
use super::model::FolderSyncState;
use super::model::MailSyncMode;
use crate::mail::MailCacheSettings;
use crate::mail::MailMessageCached;
use crate::mail::cache_synced_messages;
use crate::mail::now_ts;
use crate::mail::prune_mail_cache;
use crate::mail::reindex_cached_contacts;
use crate::mail::upsert_folder;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

pub(in crate::mail) fn load_folder_sync_state(
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
pub(in crate::mail) fn reset_folder_cache(
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
pub(in crate::mail) fn apply_prune_cut(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    cut: u32,
) -> SqlResult<usize> {
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
    Ok(deleted)
}

/// Record a per-folder sync failure so the UI can show it.
pub(in crate::mail) fn record_folder_error(
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

/// Write one step's result: messages, deletions, flag changes and the new
/// watermark, then prune — all in one transaction.
/// Milliseconds since the epoch (flag-change ordering).
pub(in crate::mail) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Apply one sync step. `started_ms` is when the step began talking to the
/// server: flags changed locally after that are newer than what it read.
pub(in crate::mail) fn apply_folder_step(
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
    let replaced = cache_synced_messages(&tx, &outcome.messages, started_ms)?;
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
    // Concurrent tabs/processes can apply older snapshots after a newer batch.
    // Backfill only lowers the watermark; completion cannot regress. Retention
    // still advances the boundary below, and UIDVALIDITY reset clears it above.
    let can_lower = matches!(outcome.mode, MailSyncMode::Initial | MailSyncMode::Backfill);
    tx.execute(
        "UPDATE mail_folders
         SET sync_low_uid = CASE WHEN sync_low_uid IS NULL THEN ?3
                                 WHEN ?10 = 1 THEN MIN(sync_low_uid, COALESCE(?3, sync_low_uid))
                                 ELSE MAX(sync_low_uid, COALESCE(?3, 0)) END,
             sync_high_uid = CASE WHEN ?4 IS NULL THEN sync_high_uid
                                  ELSE MAX(COALESCE(sync_high_uid, 0), ?4) END,
             sync_complete = MAX(sync_complete, ?5),
             sync_needs_repair = ?6, last_error = NULL,
             highest_modseq = CASE WHEN ?7 IS NULL THEN highest_modseq
                                   ELSE MAX(COALESCE(highest_modseq, 0), ?7) END,
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
    let pruned = prune_mail_cache(&tx, account_id, folder_name, cache)?;
    if replaced || pruned > 0 || outcome.uid_validity_reset || !outcome.vanished.is_empty() {
        reindex_cached_contacts(&tx, account_id)?;
    }
    tx.commit()?;
    let folder = super::super::list_cached_folders(conn, account_id)?
        .into_iter()
        .find(|folder| folder.name == folder_name);
    Ok(AppliedStep {
        flags_updated,
        folder,
    })
}

pub(in crate::mail) fn count_unseen(messages: &[MailMessageCached]) -> usize {
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
