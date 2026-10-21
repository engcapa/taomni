use rusqlite::Connection;
use rusqlite::Result as SqlResult;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

pub fn init_db(conn: &Connection) -> SqlResult<()> {
    // Enforce ON DELETE CASCADE for steps / tag-links / alert events.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            completed_at INTEGER,
            pinned INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            color TEXT,
            priority INTEGER NOT NULL DEFAULT 0,
            due_at INTEGER,
            reminder_at INTEGER,
            repeat_rule TEXT,
            source_tab_id TEXT,
            source_session_id TEXT,
            source_title TEXT,
            source_uri TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS note_steps (
            id TEXT PRIMARY KEY,
            note_id TEXT NOT NULL,
            title TEXT NOT NULL,
            completed_at INTEGER,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS note_tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS note_tag_links (
            note_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (note_id, tag_id),
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES note_tags(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS note_prefs (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS note_alert_events (
            id TEXT PRIMARY KEY,
            note_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            fire_at INTEGER NOT NULL,
            acknowledged_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_notes_active
            ON notes(completed_at, archived_at, pinned, due_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_notes_due
            ON notes(due_at);
        CREATE INDEX IF NOT EXISTS idx_notes_reminder
            ON notes(reminder_at);
        CREATE INDEX IF NOT EXISTS idx_note_steps_note
            ON note_steps(note_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_note_alert_events_state
            ON note_alert_events(state, fire_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_note_alert_events_note_kind
            ON note_alert_events(note_id, kind);",
    )?;
    Ok(())
}
