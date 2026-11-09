//! Content-only, optimistic saves shared by the compact and Workspace editors.
//! Compare actual strings: second-resolution timestamps are not revision tokens.

use rusqlite::{Connection, params};
use serde::Serialize;

use super::{NoteItem, get_note, now};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum ContentSaveError {
    Conflict(String),
    Missing(String),
    Storage(String),
}

impl From<rusqlite::Error> for ContentSaveError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

pub fn save_content(
    conn: &Connection,
    id: &str,
    title: &str,
    body: &str,
    expected_title: &str,
    expected_body: &str,
) -> Result<NoteItem, ContentSaveError> {
    let changed = conn.execute(
        "UPDATE notes SET title = ?1, body = ?2, updated_at = ?3
         WHERE id = ?4 AND title = ?5 AND body = ?6",
        params![title, body, now(), id, expected_title, expected_body],
    )?;
    let current = get_note(conn, id)?;
    if changed == 0 {
        return Err(if current.is_some() {
            ContentSaveError::Conflict("The note was changed in another editor.".into())
        } else {
            ContentSaveError::Missing("The note was deleted.".into())
        });
    }
    current.ok_or_else(|| ContentSaveError::Missing("The note was deleted.".into()))
}

#[cfg(test)]
#[path = "content_tests.rs"]
mod tests;
