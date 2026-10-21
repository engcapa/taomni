use super::model::NoteItem;
use super::model::NoteStep;
use super::model::NoteTag;
use rusqlite::Result as SqlResult;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

pub(super) const NOTE_COLUMNS: &str = "id, title, body, completed_at, pinned, archived_at, color, priority, \
     due_at, reminder_at, repeat_rule, source_tab_id, source_session_id, source_title, \
     source_uri, created_at, updated_at";

pub(super) fn row_to_note(row: &rusqlite::Row) -> SqlResult<NoteItem> {
    Ok(NoteItem {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        completed_at: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        archived_at: row.get(5)?,
        color: row.get(6)?,
        priority: row.get(7)?,
        due_at: row.get(8)?,
        reminder_at: row.get(9)?,
        repeat_rule: row.get(10)?,
        source_tab_id: row.get(11)?,
        source_session_id: row.get(12)?,
        source_title: row.get(13)?,
        source_uri: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        steps: Vec::new(),
        tags: Vec::new(),
    })
}

pub(super) fn row_to_step(row: &rusqlite::Row) -> SqlResult<NoteStep> {
    Ok(NoteStep {
        id: row.get(0)?,
        note_id: row.get(1)?,
        title: row.get(2)?,
        completed_at: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub(super) fn row_to_tag(row: &rusqlite::Row) -> SqlResult<NoteTag> {
    Ok(NoteTag {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}
