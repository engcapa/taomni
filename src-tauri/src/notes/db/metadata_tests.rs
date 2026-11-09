use rusqlite::Connection;
use serde_json::json;

use super::*;
use crate::notes::db::{
    CreateNoteInput, StepInput, TagInput, ack_alert, create_note, delete_note, init_db,
    list_alerts, save_content, set_steps, upsert_tags,
};

fn setup() -> (Connection, NoteItem) {
    let conn = Connection::open_in_memory().unwrap();
    init_db(&conn).unwrap();
    let note = create_note(
        &conn,
        &CreateNoteInput {
            title: Some("title".into()),
            body: Some("body".into()),
            priority: Some(1),
            due_at: Some(100),
            reminder_at: Some(90),
            repeat_rule: Some("reserved".into()),
            source_uri: Some("taomni://source".into()),
            ..Default::default()
        },
    )
    .unwrap();
    (conn, note)
}

fn patch(conn: &Connection, id: &str, value: serde_json::Value) -> NoteItem {
    update_metadata(conn, id, &serde_json::from_value(value).unwrap())
        .unwrap()
        .unwrap()
}

#[test]
fn metadata_and_content_saves_commute_and_retain_other_state() {
    let (conn, note) = setup();
    set_steps(
        &conn,
        &note.id,
        &[StepInput {
            id: None,
            title: "step".into(),
            completed_at: None,
            sort_order: None,
        }],
    )
    .unwrap();
    let tags = upsert_tags(
        &conn,
        &[TagInput {
            id: None,
            name: "tag".into(),
            color: None,
        }],
    )
    .unwrap();
    patch(
        &conn,
        &note.id,
        json!({"pinned": true, "tag_ids": [tags[0].id]}),
    );
    save_content(&conn, &note.id, "new title", "new body", "title", "body").unwrap();
    let saved = patch(
        &conn,
        &note.id,
        json!({"priority": 3, "completed_at": 1234}),
    );
    assert_eq!(
        (saved.title.as_str(), saved.body.as_str()),
        ("new title", "new body")
    );
    assert!(saved.pinned);
    assert_eq!(saved.priority, 3);
    assert_eq!(saved.completed_at, Some(1234));
    assert_eq!(saved.due_at, Some(100));
    assert_eq!(saved.reminder_at, Some(90));
    assert_eq!(saved.source_uri, note.source_uri);
    assert_eq!(saved.repeat_rule, note.repeat_rule);
    assert_eq!(saved.steps[0].title, "step");
    assert_eq!(saved.tags[0].id, tags[0].id);
    save_content(
        &conn,
        &note.id,
        "last title",
        "last body",
        "new title",
        "new body",
    )
    .unwrap();
    assert_eq!(get_note(&conn, &note.id).unwrap().unwrap().priority, 3);
}

#[test]
fn omitted_nullable_fields_are_retained_and_explicit_null_clears() {
    let (conn, note) = setup();
    let saved = patch(
        &conn,
        &note.id,
        json!({"color": "#123456", "completed_at": 200}),
    );
    assert_eq!(saved.due_at, Some(100));
    let saved = patch(
        &conn,
        &note.id,
        json!({"due_at": null, "color": null, "completed_at": null}),
    );
    assert_eq!(saved.due_at, None);
    assert_eq!(saved.color, None);
    assert_eq!(saved.completed_at, None);
    assert_eq!(saved.reminder_at, Some(90));
}

#[test]
fn acknowledgements_survive_unrelated_or_identical_patches() {
    let (conn, note) = setup();
    let alerts = list_alerts(&conn, 110, 1800).unwrap();
    for alert in &alerts {
        ack_alert(&conn, &alert.id).unwrap();
    }
    patch(
        &conn,
        &note.id,
        json!({"pinned": true, "priority": 2, "due_at": 100}),
    );
    assert!(
        list_alerts(&conn, 110, 1800)
            .unwrap()
            .iter()
            .all(|alert| alert.state == "acknowledged")
    );
    patch(&conn, &note.id, json!({"due_at": 105}));
    assert!(
        list_alerts(&conn, 110, 1800)
            .unwrap()
            .iter()
            .all(|alert| alert.state == "pending")
    );
    patch(&conn, &note.id, json!({"completed_at": 109}));
    assert!(list_alerts(&conn, 110, 1800).unwrap().is_empty());
}

#[test]
fn invalid_tag_rolls_back_metadata_and_existing_links() {
    let (conn, note) = setup();
    let tags = upsert_tags(
        &conn,
        &[TagInput {
            id: None,
            name: "keep".into(),
            color: None,
        }],
    )
    .unwrap();
    patch(&conn, &note.id, json!({"tag_ids": [tags[0].id]}));
    let patch = serde_json::from_value(json!({"priority": 3, "tag_ids": ["missing"]})).unwrap();
    assert!(update_metadata(&conn, &note.id, &patch).is_err());
    let saved = get_note(&conn, &note.id).unwrap().unwrap();
    assert_eq!(saved.priority, 1);
    assert_eq!(saved.tags[0].id, tags[0].id);
}

#[test]
fn deleted_note_is_not_recreated_and_invalid_priority_is_rejected() {
    let (conn, note) = setup();
    let invalid = serde_json::from_value(json!({"priority": 4})).unwrap();
    assert!(update_metadata(&conn, &note.id, &invalid).is_err());
    assert_eq!(get_note(&conn, &note.id).unwrap().unwrap().priority, 1);
    delete_note(&conn, &note.id).unwrap();
    assert!(
        update_metadata(&conn, &note.id, &NoteMetadataPatch::default())
            .unwrap()
            .is_none()
    );
}
