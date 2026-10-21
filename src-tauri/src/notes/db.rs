//! Storage layer for the unified Tao Notes feature.
//!
//! Notes live in their own SQLite file (`notes.db`), deliberately kept separate
//! from `taomni.db` so the note data model, backup, and future encryption can
//! evolve independently (see `tao-notes-feature-plan.md`).
//!
//! All timestamps are Unix **seconds** (matching the chat module's `now()`), so
//! the frontend divides `Date.now()` by 1000 before sending times over IPC.

mod identity;

mod model;

mod schema;

mod rows;

mod mutations;

mod query;

mod steps;

mod tags;

mod preferences;

mod alerts;

#[cfg(test)]
mod tests;

pub use identity::{DEFAULT_DUE_SOON_SECS, now};

pub use model::{
    CreateNoteInput, NoteAlert, NoteItem, NoteQuery, NoteStep, NoteTag, StepInput, TagInput,
    UpdateNoteInput,
};

pub use schema::init_db;

pub use mutations::{
    archive_note, create_note, delete_note, get_note, toggle_complete, update_note,
};

pub use query::list_notes;

pub use steps::{load_steps_for, set_steps};

pub use tags::{list_tags, load_tags_for, set_note_tags, upsert_tags};

pub use preferences::{get_prefs, set_prefs};

pub use alerts::{ack_alert, list_alerts};
