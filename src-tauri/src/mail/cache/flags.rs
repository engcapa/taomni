use crate::mail::sync;
use crate::mail::utilities::now_ts;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;

pub(in crate::mail) fn mark_cached_messages_read(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> SqlResult<()> {
    let mut changed = 0usize;
    let mut select_flags = conn.prepare_cached(
        "SELECT flags_json FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    let mut update_flags = conn.prepare_cached(
        "UPDATE mail_messages SET flags_json = ?4, updated_at = ?5, flags_local_at = ?6
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    for uid in uids {
        let flags_json: Option<String> = select_flags
            .query_row(params![account_id, folder, *uid as i64], |row| row.get(0))
            .optional()?;
        let Some(flags_json) = flags_json else {
            continue;
        };
        let mut flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        if flags_include_seen(&flags) {
            continue;
        }
        flags.push("\\Seen".into());
        let next_flags_json = serde_json::to_string(&flags).unwrap_or_else(|_| "[]".into());
        update_flags.execute(params![
            account_id,
            folder,
            *uid as i64,
            next_flags_json,
            now_ts(),
            sync::now_ms()
        ])?;
        changed += 1;
    }
    if changed > 0 {
        conn.execute(
            "UPDATE mail_folders
             SET unread = CASE
               WHEN unread IS NULL THEN NULL
               WHEN unread <= ?3 THEN 0
               ELSE unread - ?3
             END,
             updated_at = ?4
             WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder, changed as i64, now_ts()],
        )?;
    }
    Ok(())
}

pub(in crate::mail) fn flags_include_seen(flags: &[String]) -> bool {
    flags.iter().any(|flag| flag.eq_ignore_ascii_case("\\Seen"))
}

pub(in crate::mail) fn update_cached_flags(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> SqlResult<()> {
    if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(());
    }
    let mut select_flags = conn.prepare_cached(
        "SELECT flags_json FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    let mut update_flags = conn.prepare_cached(
        "UPDATE mail_messages SET flags_json = ?4, updated_at = ?5, flags_local_at = ?6
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    for uid in uids {
        let flags_json: Option<String> = select_flags
            .query_row(params![account_id, folder, *uid as i64], |row| row.get(0))
            .optional()?;
        let Some(flags_json) = flags_json else {
            continue;
        };
        let mut flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        flags.retain(|flag| !remove.iter().any(|r| flag.eq_ignore_ascii_case(r)));
        for flag in add {
            if !flags
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(flag))
            {
                flags.push(flag.clone());
            }
        }
        let next_flags_json = serde_json::to_string(&flags).unwrap_or_else(|_| "[]".into());
        update_flags.execute(params![
            account_id,
            folder,
            *uid as i64,
            next_flags_json,
            now_ts(),
            sync::now_ms()
        ])?;
    }
    Ok(())
}
