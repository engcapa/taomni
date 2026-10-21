use super::metadata::current_revision;
use super::metadata::init_tables;
use super::metadata::metadata_increment;
use super::metadata::metadata_set;
use super::model::METADATA_CLEAR_MARKER;
use super::model::METADATA_REVISION;
use rusqlite::Connection;

/// Atomically delete the snapshot and set the clear tombstone so the next
/// refresh does not resurrect it from the legacy recent list (design §4.2.5).
#[tauri::command]
pub async fn clear_welcome_run_snapshot(
    expected_revision: Option<i64>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut db = db;
    clear_run_snapshot(&mut db, expected_revision)
}

pub fn clear_run_snapshot(
    conn: &mut Connection,
    expected_revision: Option<i64>,
) -> Result<(), String> {
    init_tables(conn).map_err(|e| e.to_string())?;
    let current_revision = current_revision(conn);
    if let Some(expected) = expected_revision {
        if expected != current_revision {
            return Err(format!(
                "snapshot revision mismatch: expected {expected}, current {current_revision}"
            ));
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM welcome_run_snapshot WHERE singleton = 1", [])
        .map_err(|e| e.to_string())?;
    metadata_set(&tx, METADATA_CLEAR_MARKER, "true").map_err(|e| e.to_string())?;
    // Revision keeps advancing in metadata even after deletion (design §4.3).
    metadata_increment(&tx, METADATA_REVISION).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
