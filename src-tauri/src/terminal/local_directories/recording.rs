use super::identity::begin_identity_probe;
use super::identity::finish_identity_probe;
use super::limits::SOURCE_LOCAL_CWD;
use super::limits::SOURCE_LOCAL_START;
use super::schema::METADATA_DIRECTORY_REVISION;
use super::schema::directory_revision;
use super::schema::metadata_increment;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use std::path::Path;

pub fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Record a confirmed use of `path` at `now_ms`. Returns `(changed, revision)`.
pub fn record_directory_use(
    conn: &mut Connection,
    path: &Path,
    source: &str,
    now_ms: i64,
) -> Result<(bool, i64), String> {
    // Phase A: probe identity (DB reads only).
    let probe = begin_identity_probe(conn, path)?;
    let Some(probe) = probe else {
        return Err(format!("invalid local directory path: {}", path.display()));
    };

    // Phase B: filesystem confirmation with no DB lock held.
    let identity = finish_identity_probe(&probe, path)?;

    // Phase C: transactional write.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let directory_id = if identity.directory_id.is_empty() {
        let id = uuid::Uuid::new_v4().simple().to_string();
        tx.execute(
            "INSERT INTO welcome_directory_usage
             (directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank, legacy_observed_at_ms)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
            params![id, path.to_string_lossy(), now_ms, source],
        )
        .map_err(|e| e.to_string())?;
        id
    } else {
        identity.directory_id.clone()
    };

    let mut changed = identity.directory_id.is_empty();
    let mut keys = identity.new_keys.clone();
    keys.dedup();
    for key in &keys {
        let exists: Option<String> = tx
            .query_row(
                "SELECT directory_id FROM welcome_directory_alias WHERE path_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            tx.execute(
                "INSERT INTO welcome_directory_alias (path_key, directory_id, display_path)
                 VALUES (?1, ?2, ?3)",
                params![key, directory_id, path.to_string_lossy()],
            )
            .map_err(|e| e.to_string())?;
            changed = true;
        }
    }

    // Upsert confirmed time: never regress; same-time source precedence
    // local-start over local-cwd.
    let existing: Option<(Option<i64>, Option<String>)> = tx
        .query_row(
            "SELECT last_used_at_ms, last_use_source FROM welcome_directory_usage WHERE directory_id = ?1",
            params![directory_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (prev_time, prev_source) = existing.clone().unwrap_or((None, None));
    let (next_time, next_source) = match (prev_time, prev_source) {
        (Some(prev_ms), Some(prev_source)) => {
            if now_ms > prev_ms {
                (Some(now_ms), Some(source.to_string()))
            } else if now_ms == prev_ms
                && prev_source == SOURCE_LOCAL_CWD
                && source == SOURCE_LOCAL_START
            {
                (Some(prev_ms), Some(source.to_string()))
            } else {
                let keep_source = prev_source;
                (Some(prev_ms), Some(keep_source))
            }
        }
        (None, _) => (Some(now_ms), Some(source.to_string())),
        (Some(prev_ms), None) => {
            if now_ms >= prev_ms {
                (Some(now_ms), Some(source.to_string()))
            } else {
                (Some(prev_ms), None)
            }
        }
    };
    let existing_time = existing.as_ref().and_then(|(t, _)| *t);
    let existing_source = existing.as_ref().and_then(|(_, src)| src.clone());
    if next_time != existing_time || next_source != existing_source {
        tx.execute(
            "UPDATE welcome_directory_usage
             SET last_used_at_ms = ?1, last_use_source = ?2 WHERE directory_id = ?3",
            params![next_time, next_source, directory_id],
        )
        .map_err(|e| e.to_string())?;
        changed = true;
    }

    let revision = if changed {
        metadata_increment(&tx, METADATA_DIRECTORY_REVISION).map_err(|e| e.to_string())?
    } else {
        directory_revision(&tx)
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok((changed, revision))
}
