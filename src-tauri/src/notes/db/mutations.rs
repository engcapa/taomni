use super::identity::new_id;
use super::identity::now;
use super::model::CreateNoteInput;
use super::model::NoteItem;
use super::model::UpdateNoteInput;
use super::rows::NOTE_COLUMNS;
use super::rows::row_to_note;
use super::steps::load_steps_for;
use super::tags::load_tags_for;
use super::tags::set_note_tags;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;

// ---------------------------------------------------------------------------
// Note CRUD
// ---------------------------------------------------------------------------

pub fn create_note(conn: &Connection, input: &CreateNoteInput) -> SqlResult<NoteItem> {
    let ts = now();
    let id = new_id();
    conn.execute(
        "INSERT INTO notes
         (id, title, body, completed_at, pinned, archived_at, color, priority,
          due_at, reminder_at, repeat_rule, source_tab_id, source_session_id,
          source_title, source_uri, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id,
            input.title.clone().unwrap_or_default(),
            input.body.clone().unwrap_or_default(),
            input.pinned.unwrap_or(false) as i64,
            input.color,
            input.priority.unwrap_or(0),
            input.due_at,
            input.reminder_at,
            input.repeat_rule,
            input.source_tab_id,
            input.source_session_id,
            input.source_title,
            input.source_uri,
            ts,
            ts,
        ],
    )?;
    if let Some(tag_ids) = &input.tag_ids {
        set_note_tags(conn, &id, tag_ids)?;
    }
    get_note(conn, &id).map(|n| n.expect("note just inserted"))
}

pub fn get_note(conn: &Connection, id: &str) -> SqlResult<Option<NoteItem>> {
    let sql = format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1");
    let mut note = match conn.query_row(&sql, params![id], row_to_note).optional()? {
        Some(n) => n,
        None => return Ok(None),
    };
    note.steps = load_steps_for(conn, id)?;
    note.tags = load_tags_for(conn, id)?;
    Ok(Some(note))
}

pub fn delete_note(conn: &Connection, id: &str) -> SqlResult<()> {
    // Steps / tag-links / alert events cascade via FK.
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn toggle_complete(
    conn: &Connection,
    id: &str,
    completed: bool,
) -> SqlResult<Option<NoteItem>> {
    let ts = now();
    let completed_at = if completed { Some(ts) } else { None };
    conn.execute(
        "UPDATE notes SET completed_at = ?1, updated_at = ?2 WHERE id = ?3",
        params![completed_at, ts, id],
    )?;
    // Completing/uncompleting changes alert qualification; clear stale events.
    conn.execute(
        "DELETE FROM note_alert_events WHERE note_id = ?1",
        params![id],
    )?;
    get_note(conn, id)
}

pub fn archive_note(conn: &Connection, id: &str, archived: bool) -> SqlResult<Option<NoteItem>> {
    let ts = now();
    let archived_at = if archived { Some(ts) } else { None };
    conn.execute(
        "UPDATE notes SET archived_at = ?1, updated_at = ?2 WHERE id = ?3",
        params![archived_at, ts, id],
    )?;
    conn.execute(
        "DELETE FROM note_alert_events WHERE note_id = ?1",
        params![id],
    )?;
    get_note(conn, id)
}

pub fn update_note(
    conn: &Connection,
    id: &str,
    patch: &UpdateNoteInput,
) -> SqlResult<Option<NoteItem>> {
    let ts = now();
    // Capture the prior schedule so we only invalidate acknowledgements when the
    // fields that drive alert qualification actually change (a plain title/body
    // edit must not resurface an alert the user already acknowledged).
    let prev_schedule: Option<(Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT due_at, reminder_at FROM notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    let affected = conn.execute(
        "UPDATE notes SET
            title = ?1, body = ?2, pinned = ?3, color = ?4, priority = ?5,
            due_at = ?6, reminder_at = ?7, repeat_rule = ?8, source_tab_id = ?9,
            source_session_id = ?10, source_title = ?11, source_uri = ?12,
            updated_at = ?13
         WHERE id = ?14",
        params![
            patch.title,
            patch.body,
            patch.pinned.unwrap_or(false) as i64,
            patch.color,
            patch.priority.unwrap_or(0),
            patch.due_at,
            patch.reminder_at,
            patch.repeat_rule,
            patch.source_tab_id,
            patch.source_session_id,
            patch.source_title,
            patch.source_uri,
            ts,
            id,
        ],
    )?;
    if affected == 0 {
        return Ok(None);
    }
    if let Some(tag_ids) = &patch.tag_ids {
        set_note_tags(conn, id, tag_ids)?;
    }
    // Only editing due/reminder invalidates prior alert acknowledgements; other
    // edits keep them so the same alert stays acknowledged (list_alerts then
    // re-derives fresh pending events from the new schedule).
    let schedule_changed = prev_schedule
        .map(|(prev_due, prev_reminder)| {
            prev_due != patch.due_at || prev_reminder != patch.reminder_at
        })
        .unwrap_or(true);
    if schedule_changed {
        conn.execute(
            "DELETE FROM note_alert_events WHERE note_id = ?1",
            params![id],
        )?;
    }
    get_note(conn, id)
}
