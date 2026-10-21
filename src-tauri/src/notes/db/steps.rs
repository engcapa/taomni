use super::identity::new_id;
use super::identity::now;
use super::model::NoteStep;
use super::model::StepInput;
use super::rows::row_to_step;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;
use rusqlite::params;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

pub fn load_steps_for(conn: &Connection, note_id: &str) -> SqlResult<Vec<NoteStep>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, title, completed_at, sort_order, created_at, updated_at
         FROM note_steps WHERE note_id = ?1 ORDER BY sort_order ASC, created_at ASC",
    )?;
    let rows = stmt.query_map(params![note_id], row_to_step)?;
    rows.collect()
}

/// Replace the full ordered step list for a note.
pub fn set_steps(
    conn: &Connection,
    note_id: &str,
    steps: &[StepInput],
) -> SqlResult<Vec<NoteStep>> {
    let ts = now();
    conn.execute(
        "DELETE FROM note_steps WHERE note_id = ?1",
        params![note_id],
    )?;
    for (i, step) in steps.iter().enumerate() {
        let id = step.id.clone().unwrap_or_else(new_id);
        conn.execute(
            "INSERT INTO note_steps (id, note_id, title, completed_at, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                note_id,
                step.title,
                step.completed_at,
                step.sort_order.unwrap_or(i as i64),
                ts,
                ts,
            ],
        )?;
    }
    conn.execute(
        "UPDATE notes SET updated_at = ?1 WHERE id = ?2",
        params![ts, note_id],
    )?;
    load_steps_for(conn, note_id)
}
