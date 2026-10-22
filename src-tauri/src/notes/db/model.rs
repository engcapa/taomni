use serde::Deserialize;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NoteItem {
    pub id: String,
    pub title: String,
    pub body: String,
    pub completed_at: Option<i64>,
    pub pinned: bool,
    pub archived_at: Option<i64>,
    pub color: Option<String>,
    pub priority: i64,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
    pub repeat_rule: Option<String>,
    pub source_tab_id: Option<String>,
    pub source_session_id: Option<String>,
    pub source_title: Option<String>,
    pub source_uri: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub steps: Vec<NoteStep>,
    #[serde(default)]
    pub tags: Vec<NoteTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteStep {
    pub id: String,
    pub note_id: String,
    pub title: String,
    pub completed_at: Option<i64>,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteTag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A live alert derived from a note's `due_at` / `reminder_at`, reconciled into
/// the `note_alert_events` table so acknowledgements persist across polls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteAlert {
    pub id: String,
    pub note_id: String,
    /// "overdue" | "due_soon" | "reminder"
    pub kind: String,
    /// "pending" | "acknowledged"
    pub state: String,
    pub fire_at: i64,
    pub acknowledged_at: Option<i64>,
    pub note_title: String,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NoteQuery {
    /// "recent_incomplete" (default) | "all" | "pinned" | "today" | "due_soon"
    /// | "overdue" | "completed" | "archived" | "tag"
    pub filter: Option<String>,
    /// Multi-select status filters. When present, filters are OR-combined.
    #[serde(default)]
    pub filters: Option<Vec<String>>,
    pub search: Option<String>,
    pub tag_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// Reference "now" (seconds) for time-based filters; defaults to server now.
    pub now: Option<i64>,
    /// Override the due-soon window in seconds.
    pub due_soon_secs: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CreateNoteInput {
    pub title: Option<String>,
    pub body: Option<String>,
    pub pinned: Option<bool>,
    pub color: Option<String>,
    pub priority: Option<i64>,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
    pub repeat_rule: Option<String>,
    pub source_tab_id: Option<String>,
    pub source_session_id: Option<String>,
    pub source_title: Option<String>,
    pub source_uri: Option<String>,
    pub tag_ids: Option<Vec<String>>,
}

/// Full-replace patch: the editor sends the complete editable state on save, so
/// nullable fields (`due_at`, `color`, …) are cleared simply by sending null.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct UpdateNoteInput {
    pub title: String,
    pub body: String,
    pub pinned: Option<bool>,
    pub color: Option<String>,
    pub priority: Option<i64>,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
    pub repeat_rule: Option<String>,
    pub source_tab_id: Option<String>,
    pub source_session_id: Option<String>,
    pub source_title: Option<String>,
    pub source_uri: Option<String>,
    pub tag_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StepInput {
    pub id: Option<String>,
    pub title: String,
    pub completed_at: Option<i64>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TagInput {
    pub id: Option<String>,
    pub name: String,
    pub color: Option<String>,
}
