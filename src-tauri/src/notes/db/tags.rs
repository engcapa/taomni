use super::identity::new_id;
use super::identity::now;
use super::model::NoteTag;
use super::model::TagInput;
use super::rows::row_to_tag;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Result as SqlResult;
use rusqlite::params;

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

pub fn load_tags_for(conn: &Connection, note_id: &str) -> SqlResult<Vec<NoteTag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, t.created_at, t.updated_at
         FROM note_tags t JOIN note_tag_links l ON l.tag_id = t.id
         WHERE l.note_id = ?1 ORDER BY t.name ASC",
    )?;
    let rows = stmt.query_map(params![note_id], row_to_tag)?;
    rows.collect()
}

pub fn list_tags(conn: &Connection) -> SqlResult<Vec<NoteTag>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, created_at, updated_at FROM note_tags ORDER BY name ASC",
    )?;
    let rows = stmt.query_map([], row_to_tag)?;
    rows.collect()
}

/// Create or update tags by id (update) or name (create-if-absent). Returns the
/// resolved tags with their canonical ids.
pub fn upsert_tags(conn: &Connection, tags: &[TagInput]) -> SqlResult<Vec<NoteTag>> {
    let ts = now();
    let mut out = Vec::new();
    for tag in tags {
        let name = tag.name.trim();
        if name.is_empty() {
            continue;
        }
        // Prefer an explicit id, else match an existing tag by name.
        let existing_id: Option<String> = if let Some(id) = tag.id.clone().filter(|s| !s.is_empty())
        {
            Some(id)
        } else {
            conn.query_row(
                "SELECT id FROM note_tags WHERE name = ?1",
                params![name],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        };
        let id = match existing_id {
            Some(id) => {
                conn.execute(
                    "UPDATE note_tags SET name = ?1, color = ?2, updated_at = ?3 WHERE id = ?4",
                    params![name, tag.color, ts, id],
                )?;
                id
            }
            None => {
                let id = new_id();
                conn.execute(
                    "INSERT INTO note_tags (id, name, color, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, name, tag.color, ts],
                )?;
                id
            }
        };
        if let Some(tag) = conn
            .query_row(
                "SELECT id, name, color, created_at, updated_at FROM note_tags WHERE id = ?1",
                params![id],
                row_to_tag,
            )
            .optional()?
        {
            out.push(tag);
        }
    }
    Ok(out)
}

/// Replace a note's tag links with `tag_ids`.
pub fn set_note_tags(conn: &Connection, note_id: &str, tag_ids: &[String]) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM note_tag_links WHERE note_id = ?1",
        params![note_id],
    )?;
    for tag_id in tag_ids {
        conn.execute(
            "INSERT OR IGNORE INTO note_tag_links (note_id, tag_id) VALUES (?1, ?2)",
            params![note_id, tag_id],
        )?;
    }
    Ok(())
}
