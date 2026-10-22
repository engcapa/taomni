use super::alerts::ack_alert;
use super::alerts::list_alerts;
use super::identity::DEFAULT_DUE_SOON_SECS;
use super::identity::now;
use super::model::CreateNoteInput;
use super::model::NoteItem;
use super::model::NoteQuery;
use super::model::StepInput;
use super::model::TagInput;
use super::model::UpdateNoteInput;
use super::mutations::archive_note;
use super::mutations::create_note;
use super::mutations::delete_note;
use super::mutations::get_note;
use super::mutations::toggle_complete;
use super::mutations::update_note;
use super::preferences::get_prefs;
use super::preferences::set_prefs;
use super::query::list_notes;
use super::schema::init_db;
use super::steps::set_steps;
use super::tags::list_tags;
use super::tags::set_note_tags;
use super::tags::upsert_tags;
use rusqlite::Connection;
use std::collections::HashMap;

fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_db(&conn).unwrap();
    conn
}

fn create(conn: &Connection, title: &str) -> NoteItem {
    create_note(
        conn,
        &CreateNoteInput {
            title: Some(title.into()),
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn schema_init_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    init_db(&conn).unwrap();
    // Running again must not error.
    init_db(&conn).unwrap();
}

#[test]
fn create_defaults_to_incomplete() {
    let conn = mem();
    let note = create(&conn, "Buy milk");
    assert!(note.completed_at.is_none());
    assert!(!note.pinned);
    assert!(note.archived_at.is_none());
    assert_eq!(note.priority, 0);
    assert_eq!(note.body, "");
}

#[test]
fn toggle_complete_round_trip() {
    let conn = mem();
    let note = create(&conn, "Task");
    let done = toggle_complete(&conn, &note.id, true).unwrap().unwrap();
    assert!(done.completed_at.is_some());
    let reopened = toggle_complete(&conn, &note.id, false).unwrap().unwrap();
    assert!(reopened.completed_at.is_none());
}

#[test]
fn recent_incomplete_excludes_completed_and_archived() {
    let conn = mem();
    let a = create(&conn, "A");
    let b = create(&conn, "B");
    let c = create(&conn, "C");
    toggle_complete(&conn, &b.id, true).unwrap();
    archive_note(&conn, &c.id, true).unwrap();
    let notes = list_notes(&conn, &NoteQuery::default()).unwrap();
    let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, vec![a.id.as_str()]);
}

#[test]
fn multi_status_filter_unions_completed_and_archived() {
    let conn = mem();
    let active = create(&conn, "A");
    let completed = create(&conn, "B");
    let archived = create(&conn, "C");
    toggle_complete(&conn, &completed.id, true).unwrap();
    archive_note(&conn, &archived.id, true).unwrap();
    let notes = list_notes(
        &conn,
        &NoteQuery {
            filters: Some(vec!["completed".into(), "archived".into()]),
            ..Default::default()
        },
    )
    .unwrap();
    let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
    assert!(ids.contains(&completed.id.as_str()));
    assert!(ids.contains(&archived.id.as_str()));
    assert!(!ids.contains(&active.id.as_str()));
}

#[test]
fn sort_pinned_then_due_then_updated() {
    let conn = mem();
    let plain = create(&conn, "plain");
    let due_soon = create(&conn, "due");
    let pinned = create(&conn, "pinned");
    update_note(
        &conn,
        &due_soon.id,
        &UpdateNoteInput {
            title: "due".into(),
            due_at: Some(now() + 60),
            ..Default::default()
        },
    )
    .unwrap();
    update_note(
        &conn,
        &pinned.id,
        &UpdateNoteInput {
            title: "pinned".into(),
            pinned: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let notes = list_notes(&conn, &NoteQuery::default()).unwrap();
    assert_eq!(notes[0].id, pinned.id, "pinned first");
    assert_eq!(notes[1].id, due_soon.id, "then earliest due");
    assert_eq!(notes[2].id, plain.id, "null due last");
}

#[test]
fn search_matches_title_body_and_tags() {
    let conn = mem();
    let by_title = create(&conn, "deployment plan");
    let by_body = create_note(
        &conn,
        &CreateNoteInput {
            title: Some("misc".into()),
            body: Some("remember the deployment steps".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let tags = upsert_tags(
        &conn,
        &[TagInput {
            id: None,
            name: "deployment".into(),
            color: None,
        }],
    )
    .unwrap();
    let by_tag = create(&conn, "tagged");
    set_note_tags(&conn, &by_tag.id, &[tags[0].id.clone()]).unwrap();

    let hits = list_notes(
        &conn,
        &NoteQuery {
            search: Some("deployment".into()),
            filter: Some("all".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let ids: std::collections::HashSet<&str> = hits.iter().map(|n| n.id.as_str()).collect();
    assert!(ids.contains(by_title.id.as_str()));
    assert!(ids.contains(by_body.id.as_str()));
    assert!(ids.contains(by_tag.id.as_str()));
}

#[test]
fn steps_are_ordered_and_replaced() {
    let conn = mem();
    let note = create(&conn, "chores");
    set_steps(
        &conn,
        &note.id,
        &[
            StepInput {
                id: None,
                title: "second".into(),
                completed_at: None,
                sort_order: Some(1),
            },
            StepInput {
                id: None,
                title: "first".into(),
                completed_at: None,
                sort_order: Some(0),
            },
        ],
    )
    .unwrap();
    let loaded = get_note(&conn, &note.id).unwrap().unwrap();
    assert_eq!(loaded.steps.len(), 2);
    assert_eq!(loaded.steps[0].title, "first");
    assert_eq!(loaded.steps[1].title, "second");
    // Replace with a single step.
    set_steps(
        &conn,
        &note.id,
        &[StepInput {
            id: None,
            title: "only".into(),
            completed_at: None,
            sort_order: None,
        }],
    )
    .unwrap();
    let loaded = get_note(&conn, &note.id).unwrap().unwrap();
    assert_eq!(loaded.steps.len(), 1);
    assert_eq!(loaded.steps[0].title, "only");
}

#[test]
fn tags_upsert_dedupes_by_name() {
    let conn = mem();
    let first = upsert_tags(
        &conn,
        &[TagInput {
            id: None,
            name: "urgent".into(),
            color: Some("#f00".into()),
        }],
    )
    .unwrap();
    let second = upsert_tags(
        &conn,
        &[TagInput {
            id: None,
            name: "urgent".into(),
            color: Some("#0f0".into()),
        }],
    )
    .unwrap();
    assert_eq!(first[0].id, second[0].id, "same name reuses tag");
    assert_eq!(second[0].color.as_deref(), Some("#0f0"), "color updated");
    assert_eq!(list_tags(&conn).unwrap().len(), 1);
}

#[test]
fn prefs_round_trip() {
    let conn = mem();
    let mut prefs = HashMap::new();
    prefs.insert("notes.panel.mode".into(), "\"floating\"".into());
    set_prefs(&conn, &prefs).unwrap();
    prefs.insert("notes.panel.mode".into(), "\"hub\"".into());
    set_prefs(&conn, &prefs).unwrap();
    let loaded = get_prefs(&conn).unwrap();
    assert_eq!(
        loaded.get("notes.panel.mode").map(String::as_str),
        Some("\"hub\"")
    );
}

#[test]
fn alerts_detect_overdue_due_soon_and_ack() {
    let conn = mem();
    let base = now();
    let overdue = create(&conn, "overdue");
    update_note(
        &conn,
        &overdue.id,
        &UpdateNoteInput {
            title: "overdue".into(),
            due_at: Some(base - 100),
            ..Default::default()
        },
    )
    .unwrap();
    let soon = create(&conn, "soon");
    update_note(
        &conn,
        &soon.id,
        &UpdateNoteInput {
            title: "soon".into(),
            due_at: Some(base + 60),
            ..Default::default()
        },
    )
    .unwrap();
    let far = create(&conn, "far");
    update_note(
        &conn,
        &far.id,
        &UpdateNoteInput {
            title: "far".into(),
            due_at: Some(base + 86_400),
            ..Default::default()
        },
    )
    .unwrap();

    let alerts = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
    let kinds: HashMap<&str, &str> = alerts
        .iter()
        .map(|a| (a.note_id.as_str(), a.kind.as_str()))
        .collect();
    assert_eq!(kinds.get(overdue.id.as_str()), Some(&"overdue"));
    assert_eq!(kinds.get(soon.id.as_str()), Some(&"due_soon"));
    assert!(
        !kinds.contains_key(far.id.as_str()),
        "far-future not alerted"
    );
    // Overdue sorts before due_soon.
    assert_eq!(alerts[0].kind, "overdue");

    // Ack the overdue alert; it stays but flips to acknowledged.
    let overdue_alert = alerts.iter().find(|a| a.note_id == overdue.id).unwrap();
    ack_alert(&conn, &overdue_alert.id).unwrap();
    let again = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
    let acked = again.iter().find(|a| a.note_id == overdue.id).unwrap();
    assert_eq!(acked.state, "acknowledged");

    // Completing the note clears its alert.
    toggle_complete(&conn, &overdue.id, true).unwrap();
    let after = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
    assert!(after.iter().all(|a| a.note_id != overdue.id));
}

#[test]
fn edit_preserves_ack_but_reschedule_clears_it() {
    let conn = mem();
    let base = now();
    let note = create(&conn, "pay rent");
    update_note(
        &conn,
        &note.id,
        &UpdateNoteInput {
            title: "pay rent".into(),
            due_at: Some(base - 100),
            ..Default::default()
        },
    )
    .unwrap();

    // Fire + acknowledge the overdue alert.
    let alerts = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
    let alert = alerts.iter().find(|a| a.note_id == note.id).unwrap();
    ack_alert(&conn, &alert.id).unwrap();

    // A plain title/body edit (same schedule) must keep the acknowledgement.
    update_note(
        &conn,
        &note.id,
        &UpdateNoteInput {
            title: "pay the rent".into(),
            body: "before the 1st".into(),
            due_at: Some(base - 100),
            ..Default::default()
        },
    )
    .unwrap();
    let after_edit = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
    let still = after_edit.iter().find(|a| a.note_id == note.id).unwrap();
    assert_eq!(still.state, "acknowledged", "plain edit keeps the ack");

    // Changing due_at re-qualifies the alert as pending.
    update_note(
        &conn,
        &note.id,
        &UpdateNoteInput {
            title: "pay the rent".into(),
            body: "before the 1st".into(),
            due_at: Some(base - 50),
            ..Default::default()
        },
    )
    .unwrap();
    let after_reschedule = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
    let repending = after_reschedule
        .iter()
        .find(|a| a.note_id == note.id)
        .unwrap();
    assert_eq!(repending.state, "pending", "rescheduling clears the ack");
}

#[test]
fn deleting_note_cascades_steps_tags_alerts() {
    let conn = mem();
    let note = create(&conn, "temp");
    set_steps(
        &conn,
        &note.id,
        &[StepInput {
            id: None,
            title: "s".into(),
            completed_at: None,
            sort_order: None,
        }],
    )
    .unwrap();
    let tags = upsert_tags(
        &conn,
        &[TagInput {
            id: None,
            name: "t".into(),
            color: None,
        }],
    )
    .unwrap();
    set_note_tags(&conn, &note.id, &[tags[0].id.clone()]).unwrap();
    delete_note(&conn, &note.id).unwrap();
    assert!(get_note(&conn, &note.id).unwrap().is_none());
    let orphan_steps: i64 = conn
        .query_row("SELECT COUNT(*) FROM note_steps", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orphan_steps, 0);
    let orphan_links: i64 = conn
        .query_row("SELECT COUNT(*) FROM note_tag_links", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orphan_links, 0);
}
