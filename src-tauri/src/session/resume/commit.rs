use super::metadata::current_revision;
use super::metadata::init_tables;
use super::metadata::metadata_increment;
use super::model::CommitRunSnapshotResponse;
use super::model::MAX_ENTRIES;
use super::model::METADATA_CLEAR_MARKER;
use super::model::METADATA_REVISION;
use super::model::METADATA_RUN_SEQUENCE;
use super::model::RunSnapshotRecord;
use super::model::SNAPSHOT_SCHEMA_VERSION;
use super::model::SnapshotEntry;
use super::reading::load_record;
use super::validation::validate_entry;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use std::collections::HashSet;

/// Commit a run snapshot from the main-window collector (design §4.2.1).
/// Time, sequence and revision are produced by Rust; an optional CAS guards
/// against overwriting a newer commit.
#[tauri::command]
pub async fn commit_welcome_run_snapshot(
    batch_id: String,
    entries: Vec<SnapshotEntry>,
    active_identity: Option<String>,
    expected_revision: Option<i64>,
    restored: Option<bool>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<CommitRunSnapshotResponse, String> {
    let mut entries = entries;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut db = db;
    commit_run_snapshot(
        &mut db,
        batch_id,
        &mut entries,
        active_identity,
        expected_revision,
        restored.unwrap_or(false),
    )
}

pub fn commit_run_snapshot(
    conn: &mut Connection,
    batch_id: String,
    entries: &mut Vec<SnapshotEntry>,
    active_identity: Option<String>,
    expected_revision: Option<i64>,
    restored: bool,
) -> Result<CommitRunSnapshotResponse, String> {
    init_tables(conn).map_err(|e| e.to_string())?;
    if entries.is_empty() {
        return Err("snapshot entries must not be empty".to_string());
    }
    if entries.len() > MAX_ENTRIES {
        return Err(format!(
            "snapshot entries exceed the {} item limit",
            MAX_ENTRIES
        ));
    }
    let mut seen_identities: HashSet<String> = HashSet::new();
    for entry in entries.iter_mut() {
        validate_entry(entry)?;
        if !seen_identities.insert(entry.identity().to_string()) {
            return Err(format!(
                "duplicate snapshot entry identity: {}",
                entry.identity()
            ));
        }
    }
    if let Some(active) = &active_identity {
        if !entries.iter().any(|entry| entry.identity() == active) {
            return Err(format!(
                "activeIdentity does not match any snapshot entry: {active}"
            ));
        }
    }

    // Unknown schema is never overwritten.
    let existing_version: Option<i64> = conn
        .query_row(
            "SELECT schema_version FROM welcome_run_snapshot WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(version) = existing_version {
        if version > SNAPSHOT_SCHEMA_VERSION {
            return Err(format!(
                "snapshot schema version {version} is not supported; refusing to overwrite"
            ));
        }
    }

    // CAS: don't clobber a newer commit (design §4.2.5).
    let current_revision = current_revision(conn);
    if let Some(expected) = expected_revision {
        if expected != current_revision {
            return Ok(CommitRunSnapshotResponse {
                record: load_record(conn)?,
                applied: false,
            });
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now_ms = crate::terminal::local_directories::system_now_ms();
    let revision = metadata_increment(&tx, METADATA_REVISION).map_err(|e| e.to_string())?;
    let run_sequence = metadata_increment(&tx, METADATA_RUN_SEQUENCE).map_err(|e| e.to_string())?;
    let batch_id = if batch_id.trim().is_empty() {
        uuid::Uuid::new_v4().simple().to_string()
    } else {
        batch_id
    };
    let entries_json = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO welcome_run_snapshot
         (singleton, schema_version, revision, run_sequence, batch_id, committed_at_ms,
          entries_json, active_identity)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(singleton) DO UPDATE SET
           schema_version = excluded.schema_version,
           revision = excluded.revision,
           run_sequence = excluded.run_sequence,
           batch_id = excluded.batch_id,
           committed_at_ms = excluded.committed_at_ms,
           entries_json = excluded.entries_json,
           active_identity = excluded.active_identity",
        params![
            SNAPSHOT_SCHEMA_VERSION,
            revision,
            run_sequence,
            batch_id,
            now_ms,
            entries_json,
            active_identity
        ],
    )
    .map_err(|e| e.to_string())?;
    if restored {
        // A confirmed successful restore rebuilds the record and clears the
        // tombstone (design §4.2.5).
        tx.execute(
            "DELETE FROM welcome_metadata WHERE key = ?1",
            params![METADATA_CLEAR_MARKER],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(CommitRunSnapshotResponse {
        record: Some(RunSnapshotRecord {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            revision,
            run_sequence,
            batch_id,
            committed_at_ms: now_ms,
            entries: entries.clone(),
            active_identity,
        }),
        applied: true,
    })
}
