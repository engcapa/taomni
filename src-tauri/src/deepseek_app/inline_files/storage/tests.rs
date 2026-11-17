use super::*;
use crate::deepseek_app::{inline_files, store};
use serde_json::json;

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    store::init(&db).unwrap();
    init(&db).unwrap();
    db
}

fn thread(db: &Connection, id: &str) {
    store::save_thread(db, json!({"id":id,"title":id,"updatedAt":1,"messages":[]})).unwrap();
}

fn file(db: &Connection, id: &str, thread: &str, provider: &str) {
    remember(
        db,
        id,
        thread,
        provider,
        &StoredFile {
            path: "/qa/document.txt".into(),
            hash: "expected-hash".into(),
            filename: "document.txt".into(),
            mime: "text/plain".into(),
        },
        73,
    )
    .unwrap();
}

fn attachment(id: &str, provider: &str) -> Value {
    json!({"type":"document","source":{"type":"file","file_id":id,"provider":provider}})
}

#[test]
fn branch_inherits_only_authorized_retained_user_blocks_and_composer_files() {
    let db = database();
    thread(&db, "source");
    for id in [
        "inline-visible",
        "inline-later",
        "inline-unused",
        "inline-draft",
    ] {
        file(&db, id, "source", "ordinary");
    }
    file(&db, "inline-foreign", "other-thread", "ordinary");
    file(&db, "inline-other-provider", "source", "other-provider");
    store::save_thread(
        &db,
        json!({"id":"source","updatedAt":2,"messages":[],
        "preferences":{"composer":{"chips":[
            {"fileId":"inline-draft","provider":"ordinary"},
            {"fileId":"inline-foreign","provider":"ordinary"},
            {"fileId":"inline-other-provider","provider":"ordinary"}]}}}),
    )
    .unwrap();
    store::append_message(
        &db,
        "source",
        "user",
        &[
            attachment("inline-visible", "ordinary"),
            attachment("inline-foreign", "ordinary"),
            attachment("inline-other-provider", "ordinary"),
        ],
    )
    .unwrap();
    store::append_message(
        &db,
        "source",
        "assistant",
        &[attachment("inline-unused", "ordinary")],
    )
    .unwrap();
    store::append_message(
        &db,
        "source",
        "user",
        &[attachment("inline-later", "ordinary")],
    )
    .unwrap();

    store::clone_thread(&db, "source", "branch", Some(1)).unwrap();
    for id in ["inline-visible", "inline-draft"] {
        assert!(lookup(&db, "branch", "ordinary", id).is_ok());
        assert!(lookup(&db, "branch", "other-provider", id).is_err());
        assert!(lookup(&db, "unrelated", "ordinary", id).is_err());
        assert!(lookup(&db, "source", "ordinary", id).is_ok());
    }
    for id in [
        "inline-later",
        "inline-unused",
        "inline-foreign",
        "inline-other-provider",
    ] {
        assert!(lookup(&db, "branch", "ordinary", id).is_err(), "{id}");
    }
    assert!(lookup(&db, "branch", "other-provider", "inline-other-provider").is_err());
    assert_eq!(store::messages(&db, "branch").unwrap().len(), 2);
    assert_eq!(store::messages(&db, "source").unwrap().len(), 3);
}

#[test]
fn recursive_branches_survive_database_reopen_and_thread_deletion_is_scoped() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("branch.sqlite");
    {
        let db = Connection::open(&path).unwrap();
        store::init(&db).unwrap();
        thread(&db, "source");
        file(&db, "inline-kept", "source", "ordinary");
        store::append_message(
            &db,
            "source",
            "user",
            &[attachment("inline-kept", "ordinary")],
        )
        .unwrap();
        store::clone_thread(&db, "source", "branch", None).unwrap();
        store::clone_thread(&db, "branch", "nested", None).unwrap();
    }
    let db = Connection::open(&path).unwrap();
    for owner in ["source", "branch", "nested"] {
        assert!(lookup(&db, owner, "ordinary", "inline-kept").is_ok());
    }
    store::delete_thread(&db, "branch").unwrap();
    assert!(lookup(&db, "branch", "ordinary", "inline-kept").is_err());
    assert!(lookup(&db, "source", "ordinary", "inline-kept").is_ok());
    assert!(lookup(&db, "nested", "ordinary", "inline-kept").is_ok());
    remove(&db, "inline-kept").unwrap();
    for owner in ["source", "nested"] {
        assert!(lookup(&db, owner, "ordinary", "inline-kept").is_err());
    }
    let grants: i64 = db
        .query_row("SELECT COUNT(*) FROM tao_inline_file_grants", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(grants, 0);
}

#[test]
fn reselecting_identical_attachment_preserves_branch_grants_with_foreign_keys_enabled() {
    let db = database();
    thread(&db, "source");
    file(&db, "inline-kept", "source", "ordinary");
    store::append_message(
        &db,
        "source",
        "user",
        &[attachment("inline-kept", "ordinary")],
    )
    .unwrap();
    store::clone_thread(&db, "source", "branch", None).unwrap();
    file(&db, "inline-kept", "source", "ordinary");
    assert!(lookup(&db, "branch", "ordinary", "inline-kept").is_ok());
}

#[tokio::test]
async fn inherited_file_reads_validate_current_disk_bytes_and_require_explicit_reselection() {
    let db = database();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("document.txt");
    let original = b"QA_ATTACHMENT_VALUE=73";
    std::fs::write(&path, original).unwrap();
    thread(&db, "source");
    let file = StoredFile {
        path: path.to_string_lossy().into_owned(),
        hash: inline_files::digest(original),
        filename: "document.txt".into(),
        mime: "text/plain".into(),
    };
    remember(
        &db,
        "inline-live",
        "source",
        "ordinary",
        &file,
        original.len(),
    )
    .unwrap();
    store::append_message(
        &db,
        "source",
        "user",
        &[attachment("inline-live", "ordinary")],
    )
    .unwrap();
    store::clone_thread(&db, "source", "branch", None).unwrap();
    let part = inline_files::read_part(lookup(&db, "branch", "ordinary", "inline-live").unwrap())
        .await
        .unwrap();
    assert!(
        part["text"]
            .as_str()
            .unwrap()
            .contains("QA_ATTACHMENT_VALUE=73")
    );
    std::fs::write(&path, b"unexpected new content").unwrap();
    let error = inline_files::read_part(lookup(&db, "branch", "ordinary", "inline-live").unwrap())
        .await
        .unwrap_err();
    assert!(error.contains("attachment changed"));
    std::fs::remove_file(&path).unwrap();
    let error = inline_files::read_part(lookup(&db, "branch", "ordinary", "inline-live").unwrap())
        .await
        .unwrap_err();
    assert!(error.contains("attachment is unavailable"));
}

#[test]
fn legacy_inline_blocks_keep_go_scope_and_never_grant_another_provider() {
    let db = database();
    thread(&db, "source");
    file(&db, "inline-old", "source", "opencode-go");
    store::append_message(
        &db,
        "source",
        "user",
        &[json!({"type":"document","source":{"type":"file","file_id":"inline-old"}})],
    )
    .unwrap();
    store::clone_thread(&db, "source", "branch", None).unwrap();
    assert!(lookup(&db, "branch", "opencode-go", "inline-old").is_ok());
    assert!(lookup(&db, "branch", "ordinary", "inline-old").is_err());
}

#[test]
fn branch_failure_rolls_back_snapshot_messages_and_grants_together() {
    let db = database();
    thread(&db, "source");
    file(&db, "inline-kept", "source", "ordinary");
    store::append_message(
        &db,
        "source",
        "user",
        &[attachment("inline-kept", "ordinary")],
    )
    .unwrap();
    db.execute_batch(
        "CREATE TRIGGER fail_branch BEFORE INSERT ON ds_app_messages
        WHEN NEW.thread_id='branch' BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END",
    )
    .unwrap();
    assert!(store::clone_thread(&db, "source", "branch", None).is_err());
    assert!(
        !store::load_threads(&db)
            .unwrap()
            .iter()
            .any(|t| t["id"] == "branch")
    );
    assert!(store::messages(&db, "branch").unwrap().is_empty());
    assert!(lookup(&db, "branch", "ordinary", "inline-kept").is_err());
    assert!(lookup(&db, "source", "ordinary", "inline-kept").is_ok());
    assert!(db.is_autocommit());
}
