//! Atomic task patches. Text/source fields never participate in these writes.
use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Deserializer};

use super::{NoteItem, get_note, now, set_note_tags};

// serde normally collapses missing and null for nested Options.
fn nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Deserialize)]
pub struct NoteMetadataPatch {
    pub pinned: Option<bool>,
    pub priority: Option<i64>,
    #[serde(default, deserialize_with = "nullable")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub due_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "nullable")]
    pub reminder_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "nullable")]
    pub completed_at: Option<Option<i64>>,
    pub tag_ids: Option<Vec<String>>,
}

pub fn update_metadata(
    conn: &Connection,
    id: &str,
    patch: &NoteMetadataPatch,
) -> Result<Option<NoteItem>> {
    if patch
        .priority
        .is_some_and(|value| !(0..=3).contains(&value))
    {
        return Err(rusqlite::Error::InvalidParameterName(
            "priority must be 0–3".into(),
        ));
    }
    let transaction = conn.unchecked_transaction()?;
    let Some(mut note) = get_note(&transaction, id)? else {
        return Ok(None);
    };
    let schedule = (note.due_at, note.reminder_at, note.completed_at);
    if let Some(value) = patch.pinned {
        note.pinned = value;
    }
    if let Some(value) = patch.priority {
        note.priority = value;
    }
    if let Some(value) = &patch.color {
        note.color = value.clone();
    }
    if let Some(value) = patch.due_at {
        note.due_at = value;
    }
    if let Some(value) = patch.reminder_at {
        note.reminder_at = value;
    }
    if let Some(value) = patch.completed_at {
        note.completed_at = value;
    }
    transaction.execute(
        "UPDATE notes SET pinned = ?1, priority = ?2, color = ?3,
         due_at = ?4, reminder_at = ?5, completed_at = ?6, updated_at = ?7 WHERE id = ?8",
        params![
            note.pinned,
            note.priority,
            note.color,
            note.due_at,
            note.reminder_at,
            note.completed_at,
            now(),
            id
        ],
    )?;
    if let Some(ids) = &patch.tag_ids {
        set_note_tags(&transaction, id, ids)?;
    }
    if schedule != (note.due_at, note.reminder_at, note.completed_at) {
        transaction.execute("DELETE FROM note_alert_events WHERE note_id = ?1", [id])?;
    }
    let result = get_note(&transaction, id)?;
    transaction.commit()?;
    Ok(result)
}

#[cfg(test)]
#[path = "metadata_tests.rs"]
mod tests;
