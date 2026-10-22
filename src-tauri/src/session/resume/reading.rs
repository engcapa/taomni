use super::legacy::legacy_candidate;
use super::metadata::current_revision;
use super::metadata::init_tables;
use super::metadata::metadata_get;
use super::model::GetRunSnapshotResponse;
use super::model::METADATA_CLEAR_MARKER;
use super::model::RunSnapshotRecord;
use super::model::SNAPSHOT_SCHEMA_VERSION;
use super::model::SnapshotEntry;
use super::model::SnapshotIssue;
use rusqlite::Connection;
use rusqlite::OptionalExtension;

pub(super) fn load_record(conn: &Connection) -> Result<Option<RunSnapshotRecord>, String> {
    let row = conn
        .query_row(
            "SELECT schema_version, revision, run_sequence, batch_id, committed_at_ms,
                    entries_json, active_identity
             FROM welcome_run_snapshot WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((
        schema_version,
        _revision,
        run_sequence,
        batch_id,
        committed_at_ms,
        entries_json,
        active_identity,
    )) = row
    else {
        return Ok(None);
    };
    if schema_version > SNAPSHOT_SCHEMA_VERSION {
        return Err(format!(
            "snapshot schema version {schema_version} is not supported"
        ));
    }
    let entries: Vec<SnapshotEntry> = serde_json::from_str(&entries_json)
        .map_err(|e| format!("corrupt snapshot entries: {e}"))?;
    Ok(Some(RunSnapshotRecord {
        schema_version,
        revision: current_revision(conn),
        run_sequence,
        batch_id,
        committed_at_ms,
        entries,
        active_identity,
    }))
}

#[tauri::command]
pub async fn get_welcome_run_snapshot(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<GetRunSnapshotResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    get_run_snapshot(&db)
}

pub fn get_run_snapshot(conn: &Connection) -> Result<GetRunSnapshotResponse, String> {
    init_tables(conn).map_err(|e| e.to_string())?;
    match load_record(conn) {
        Ok(record) => {
            if record.is_some() {
                return Ok(GetRunSnapshotResponse {
                    record,
                    legacy_candidate: None,
                    issue: None,
                });
            }
            let cleared = metadata_get(conn, METADATA_CLEAR_MARKER)
                .map_err(|e| e.to_string())?
                .is_some();
            let legacy_candidate = if cleared {
                None
            } else {
                legacy_candidate(conn)
            };
            Ok(GetRunSnapshotResponse {
                record: None,
                legacy_candidate,
                issue: None,
            })
        }
        Err(message) => {
            if message.contains("schema version") && message.contains("not supported") {
                return Ok(GetRunSnapshotResponse {
                    record: None,
                    legacy_candidate: None,
                    issue: Some(SnapshotIssue {
                        code: "unsupported".to_string(),
                        message,
                    }),
                });
            }
            Err(message)
        }
    }
}
