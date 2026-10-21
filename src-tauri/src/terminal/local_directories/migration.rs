use super::identity::normalize_path_key;
use super::limits::MAX_DISPLAYED_NON_DEFAULT;
use super::schema::METADATA_MIGRATION_COMPLETE;
use super::schema::METADATA_MIGRATION_COMPLETE_VALUE;
use super::schema::init_tables;
use super::schema::metadata_get;
use super::schema::metadata_set;
use crate::terminal::pty;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use std::collections::HashMap;
use std::path::Path;

// ---------------------------------------------------------------------------
// Legacy command-history migration
// ---------------------------------------------------------------------------

/// One-time import of legacy directory hints from `command_history`. Old
/// observation times stay in `legacy_observed_at_ms` and never become
/// confirmed use times. Idempotent: guarded by the
/// `directory_migration_v1=complete` marker written inside the same
/// transaction (interruption rolls everything back and retries next run).
pub fn migrate_legacy_history(conn: &mut Connection) -> rusqlite::Result<()> {
    init_tables(conn)?;
    if metadata_get(conn, METADATA_MIGRATION_COMPLETE)?.as_deref()
        == Some(METADATA_MIGRATION_COMPLETE_VALUE)
    {
        return Ok(());
    }
    let tx = conn.transaction()?;

    let mut rows: Vec<(i64, String, i64)> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "SELECT id, command, last_used_at FROM command_history
             WHERE host_key = 'local'
               AND (
                 lower(command) LIKE 'cd %'
                 OR lower(command) LIKE 'cd\t%'
                 OR lower(command) = 'cd'
                 OR lower(command) LIKE 'chdir %'
                 OR lower(command) LIKE 'pushd %'
                 OR lower(command) LIKE 'set-location %'
                 OR lower(command) LIKE 'sl %'
               )
             ORDER BY last_used_at DESC, id DESC
             LIMIT 300",
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    // Deterministic supplement: a recency-ordered broad window when few
    // explicit directory commands exist (new installs / PowerShell gaps).
    let mut parsed_count = 0usize;
    let mut seen_paths: HashMap<String, ()> = HashMap::new();
    let mut legacy_entries: Vec<(
        String,      /*directory_id*/
        Option<i64>, /*observed*/
        i64,         /*rank*/
    )> = Vec::new();
    let mut rank: i64 = 0;

    let home = dirs::home_dir();
    let import_command = |command: &str,
                          last_used_at: i64,
                          rank: &mut i64,
                          seen: &mut HashMap<String, ()>,
                          legacy: &mut Vec<(String, Option<i64>, i64)>,
                          parsed: &mut usize|
     -> rusqlite::Result<()> {
        let Some(path) = pty::directory_from_history_command(command, home.as_deref()) else {
            return Ok(());
        };
        let Some(key) = normalize_path_key(&path) else {
            return Ok(());
        };
        if seen.contains_key(&key) {
            return Ok(());
        }
        seen.insert(key.clone(), ());
        let directory_id = ensure_legacy_directory(&tx, &path, &key)?;
        // Valid non-negative seconds only; anything else stays unobserved.
        let observed_ms = if last_used_at >= 0 && last_used_at < 4_102_444_800 {
            Some(last_used_at.saturating_mul(1000))
        } else {
            None
        };
        legacy.push((directory_id, observed_ms, *rank));
        *rank += 1;
        *parsed += 1;
        Ok(())
    };

    for (id, command, last_used_at) in &rows {
        import_command(
            command,
            *last_used_at,
            &mut rank,
            &mut seen_paths,
            &mut legacy_entries,
            &mut parsed_count,
        )?;
        let _ = id;
    }
    if parsed_count < MAX_DISPLAYED_NON_DEFAULT {
        let mut stmt = tx.prepare(
            "SELECT command, last_used_at FROM command_history
             WHERE host_key = 'local'
             ORDER BY last_used_at DESC, id DESC
             LIMIT 500",
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in mapped {
            let (command, last_used_at) = row?;
            import_command(
                &command,
                last_used_at,
                &mut rank,
                &mut seen_paths,
                &mut legacy_entries,
                &mut parsed_count,
            )?;
        }
    }

    for (directory_id, observed_ms, entry_rank) in legacy_entries {
        tx.execute(
            "UPDATE welcome_directory_usage
             SET legacy_rank = MIN(COALESCE(legacy_rank, ?2), ?2),
                 legacy_observed_at_ms = COALESCE(legacy_observed_at_ms, ?3)
             WHERE directory_id = ?1",
            params![directory_id, entry_rank, observed_ms],
        )?;
    }

    metadata_set(
        &tx,
        METADATA_MIGRATION_COMPLETE,
        METADATA_MIGRATION_COMPLETE_VALUE,
    )?;
    tx.commit()
}

/// Create (or reuse) the null-time usage row + alias for a legacy candidate.
pub(super) fn ensure_legacy_directory(
    tx: &Connection,
    path: &Path,
    key: &str,
) -> rusqlite::Result<String> {
    let existing: Option<String> = tx
        .query_row(
            "SELECT directory_id FROM welcome_directory_alias WHERE path_key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    tx.execute(
        "INSERT INTO welcome_directory_usage
         (directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank, legacy_observed_at_ms)
         VALUES (?1, ?2, NULL, NULL, NULL, NULL)",
        params![id, path.to_string_lossy()],
    )?;
    tx.execute(
        "INSERT INTO welcome_directory_alias (path_key, directory_id, display_path)
         VALUES (?1, ?2, ?3)",
        params![key, id, path.to_string_lossy()],
    )?;
    Ok(id)
}
