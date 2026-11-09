use rusqlite::Connection;

use super::*;
use crate::notes::db::{CreateNoteInput, StepInput, create_note, init_db, set_steps};

#[test]
fn content_save_preserves_metadata_steps_and_schedule() {
    let conn = Connection::open_in_memory().unwrap();
    init_db(&conn).unwrap();
    let original = create_note(
        &conn,
        &CreateNoteInput {
            title: Some("title".into()),
            body: Some("before".into()),
            pinned: Some(true),
            priority: Some(3),
            color: Some("#abcdef".into()),
            due_at: Some(1234),
            reminder_at: Some(1200),
            ..Default::default()
        },
    )
    .unwrap();
    set_steps(
        &conn,
        &original.id,
        &[StepInput {
            id: None,
            title: "step".into(),
            completed_at: None,
            sort_order: None,
        }],
    )
    .unwrap();
    let saved = save_content(
        &conn,
        &original.id,
        "new title",
        "# 中文\nbody",
        "title",
        "before",
    )
    .unwrap();
    assert_eq!(saved.title, "new title");
    assert_eq!(saved.body, "# 中文\nbody");
    assert!(saved.pinned);
    assert_eq!(saved.priority, 3);
    assert_eq!(saved.color, original.color);
    assert_eq!(saved.due_at, original.due_at);
    assert_eq!(saved.reminder_at, original.reminder_at);
    assert_eq!(saved.steps[0].title, "step");
}

#[test]
fn stale_content_save_is_rejected_without_overwriting_newer_text() {
    let conn = Connection::open_in_memory().unwrap();
    init_db(&conn).unwrap();
    let note = create_note(
        &conn,
        &CreateNoteInput {
            body: Some("original".into()),
            ..Default::default()
        },
    )
    .unwrap();
    save_content(&conn, &note.id, "", "first writer", "", "original").unwrap();
    let result = save_content(&conn, &note.id, "", "stale writer", "", "original");
    assert!(matches!(result, Err(ContentSaveError::Conflict(_))));
    assert_eq!(
        get_note(&conn, &note.id).unwrap().unwrap().body,
        "first writer"
    );
}

#[test]
fn deleted_note_cannot_be_recreated_by_an_open_editor() {
    let conn = Connection::open_in_memory().unwrap();
    init_db(&conn).unwrap();
    let note = create_note(&conn, &CreateNoteInput::default()).unwrap();
    crate::notes::db::delete_note(&conn, &note.id).unwrap();
    assert!(matches!(
        save_content(&conn, &note.id, "draft", "draft", "", ""),
        Err(ContentSaveError::Missing(_))
    ));
    assert!(get_note(&conn, &note.id).unwrap().is_none());
}
