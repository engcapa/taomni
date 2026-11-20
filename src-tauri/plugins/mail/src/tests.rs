use std::{collections::BTreeSet, fs};

use rusqlite::Connection;
use serde_json::{Value, json};
use taomni_mail_engine::{
    MailFolder,
    cache::{init_mail_tables, upsert_folder, upsert_message},
    database::mail_db_file_stem,
    drafts::save_mail_draft,
    parse_body_message, storage,
};
use taomni_plugin_api::ErrorCode;

use super::{commands, host_config, store::Store};

fn invoke(
    store: &Store,
    method: &str,
    input: Option<Value>,
) -> Result<Value, taomni_plugin_api::RpcError> {
    commands::invoke(store, method, input, &|| Ok(()))
}

#[test]
fn draft_writes_are_account_scoped_and_retryable() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let delete = |account| json!({"accountId":account, "draftId":"draft-id"});
    invoke(&store, "mail_delete_draft", Some(delete("unknown"))).unwrap();
    assert!(!profile.path().join("plugins").exists());
    for subject in ["initial", "updated"] {
        let saved = invoke(
            &store,
            "mail_save_draft",
            Some(json!({
                "accountId":"mail-a","draft":{"id":"draft-id","subject":subject}
            })),
        )
        .unwrap();
        assert_eq!(saved["subject"], subject);
    }
    invoke(&store, "mail_delete_draft", Some(delete("mail-b"))).unwrap();
    let list = || {
        invoke(
            &store,
            "mail_list_drafts",
            Some(json!({"accountId":"mail-a"})),
        )
        .unwrap()
    };
    let drafts = list();
    assert_eq!(drafts.as_array().unwrap().len(), 1);
    assert_eq!(drafts[0]["subject"], "updated");
    invoke(&store, "mail_delete_draft", Some(delete("mail-a"))).unwrap();
    assert_eq!(list(), json!([]));
}

#[test]
fn cancellation_during_first_draft_save_leaves_no_database() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let checks = std::cell::Cell::new(0);
    let result = commands::invoke(
        &store,
        "mail_save_draft",
        Some(json!({"accountId":"cancelled","draft":{"id":"cancelled"}})),
        &|| {
            let count = checks.get() + 1;
            checks.set(count);
            if count == 3 {
                return Err(taomni_plugin_api::RpcError::from_code(
                    ErrorCode::RequestCancelled,
                ));
            }
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().code, ErrorCode::RequestCancelled as i32);
    let module = profile.path().join("plugins/mail");
    assert_eq!(module.join("data").read_dir().unwrap().count(), 0);
    assert_eq!(module.read_dir().unwrap().count(), 1);
}

#[test]
fn draft_pages_keep_outbox_fields_and_filter_by_account() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let root = profile.path().join("plugins/mail/data");
    fs::create_dir_all(&root).unwrap();
    let database =
        Connection::open(root.join(format!("{}.db", mail_db_file_stem("saved")))).unwrap();
    init_mail_tables(&database).unwrap();
    for (account, id, send_at) in [
        ("saved", "queued", 1800000010),
        ("saved", "reply", 1800000020),
        ("other", "hidden", 1),
    ] {
        let draft = serde_json::from_value(json!({
            "id":id, "subject":id, "to":["receiver@example.com"],
            "replyContext":{"outbox":{"sendAt":send_at}},
        }))
        .unwrap();
        save_mail_draft(&database, account, draft).unwrap();
    }
    // Same update timestamp to check stable pagination before and after retries.
    database
        .execute("UPDATE mail_drafts SET updated_at=1", [])
        .unwrap();
    let page = |offset| {
        invoke(
            &store,
            "mail_list_drafts",
            Some(json!({"accountId":"saved","limit":1,"offset":offset})),
        )
        .unwrap()
    };
    assert_eq!(page(0)[0]["subject"], "queued");
    assert_eq!(page(0)[0]["replyContext"]["outbox"]["sendAt"], 1800000010);
    assert_eq!(page(1)[0]["subject"], "reply");
    assert_eq!(page(2), json!([]));
}

#[test]
fn host_handshake_matches_the_manifest() {
    let manifest: Value = serde_json::from_str(include_str!("../module.json")).unwrap();
    let config = host_config();
    assert_eq!(manifest["id"], config.plugin_id);
    assert_eq!(manifest["version"], config.plugin_version);
    assert_eq!(
        serde_json::from_value::<BTreeSet<String>>(manifest["commands"].clone()).unwrap(),
        config.commands
    );
    assert_eq!(
        serde_json::from_value::<BTreeSet<String>>(manifest["permissions"].clone()).unwrap(),
        config.permissions
    );
}

#[test]
fn queries_read_the_owned_mailbox_and_do_not_create_missing_data() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let query = json!({"accountId": "saved-mail"});
    assert_eq!(
        invoke(&store, "mail_list_cached_folders", Some(query.clone())).unwrap(),
        json!([])
    );
    assert!(!profile.path().join("plugins").exists());

    let root = profile.path().join("plugins/mail/data");
    fs::create_dir_all(&root).unwrap();
    let database = root.join(format!("{}.db", mail_db_file_stem("saved-mail")));
    let write = Connection::open(database).unwrap();
    init_mail_tables(&write).unwrap();
    upsert_folder(
        &write,
        &MailFolder {
            account_id: "saved-mail".into(),
            name: "INBOX".into(),
            ..MailFolder::default()
        },
    )
    .unwrap();
    let raw = b"Subject: Retained mail\r\n\r\nSaved message body\r\n";
    upsert_message(
        &write,
        &parse_body_message("saved-mail", "INBOX", 5, None, raw, 1024),
    )
    .unwrap();

    let folders = invoke(&store, "mail_list_cached_folders", Some(query)).unwrap();
    assert_eq!(folders[0]["name"], "INBOX");
    assert_eq!(folders[0]["cachedCount"], 1);
    let message = json!({"accountId":"saved-mail","folder":"INBOX","uid":5});
    let body = invoke(&store, "mail_get_cached_body", Some(message)).unwrap();
    assert!(
        body["text"]
            .as_str()
            .unwrap()
            .contains("Saved message body")
    );
    assert_eq!(
        invoke(
            &store,
            "mail_list_cached_messages",
            Some(json!({"accountId":"other-account","folder":"INBOX"}))
        )
        .unwrap(),
        json!([])
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn saved_original_takes_precedence_and_corruption_is_reported() {
    let profile = tempfile::tempdir().unwrap();
    let root = profile.path().canonicalize().unwrap();
    let store = Store::new(&root);
    let data = root.join("plugins/mail/data");
    fs::create_dir_all(&data).unwrap();
    let account = "saved";
    let db = Connection::open(data.join(format!("{}.db", mail_db_file_stem(account)))).unwrap();
    init_mail_tables(&db).unwrap();
    let snippet = b"Subject: Cached\r\n\r\nCached snippet\r\n";
    upsert_message(
        &db,
        &parse_body_message(account, "INBOX", 5, None, snippet, 1024),
    )
    .unwrap();
    let original = b"Subject: Original\r\n\r\nFull archived body\r\n";
    let saved = storage::store(&db, account, "INBOX", 5, 1, &original[..]).unwrap();
    let read = || {
        invoke(
            &store,
            "mail_get_cached_body",
            Some(json!({"accountId":account,"folder":"INBOX","uid":5})),
        )
    };
    let body = read().unwrap();
    assert_eq!(body["source"], "archive");
    assert!(
        body["text"]
            .as_str()
            .unwrap()
            .contains("Full archived body")
    );
    let archive = storage::account_root(&db, account)
        .unwrap()
        .join("objects")
        .join(&saved.hash[..2])
        .join(format!("{}.eml.gz", saved.hash));
    fs::write(archive, b"broken archive").unwrap();
    assert_eq!(read().unwrap_err().message, "MAIL_STORE_UNAVAILABLE");
}

#[test]
fn request_cannot_supply_a_database_path_and_oversized_bodies_get_an_rpc_error() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let path = json!({"accountId":"saved","path":"taomni.db"});
    assert_eq!(
        invoke(&store, "mail_list_cached_folders", Some(path))
            .unwrap_err()
            .code,
        ErrorCode::InvalidParams as i32
    );

    let root = profile.path().join("plugins/mail/data");
    fs::create_dir_all(&root).unwrap();
    let conn = Connection::open(root.join(format!("{}.db", mail_db_file_stem("saved")))).unwrap();
    init_mail_tables(&conn).unwrap();
    conn.execute(
        "INSERT INTO mail_messages(account_id, folder, uid, body_text, body_cached_at, updated_at)
         VALUES ('saved', 'INBOX', 4, ?1, 1, 1)",
        ["x".repeat(4 * 1024 * 1024)],
    )
    .unwrap();
    let args = json!({"accountId":"saved","folder":"INBOX","uid":4});
    assert_eq!(
        invoke(&store, "mail_get_cached_body", Some(args))
            .unwrap_err()
            .message,
        "MAIL_RESULT_TOO_LARGE"
    );
}

#[cfg(unix)]
#[test]
fn directory_or_sqlite_sidecar_links_are_rejected() {
    use std::os::unix::fs::symlink;

    let profile = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let root = profile.path().join("plugins/mail");
    fs::create_dir_all(&root).unwrap();
    let link = root.join("data");
    symlink(outside.path(), &link).unwrap();
    let args = json!({"accountId":"saved"});
    assert!(invoke(&store, "mail_list_cached_folders", Some(args.clone())).is_err());

    fs::remove_file(&link).unwrap();
    fs::create_dir(&link).unwrap();
    let stem = mail_db_file_stem("saved");
    let database = Connection::open(link.join(format!("{stem}.db"))).unwrap();
    init_mail_tables(&database).unwrap();
    symlink(
        outside.path().join("not-mail"),
        link.join(format!("{stem}.db-wal")),
    )
    .unwrap();
    assert!(invoke(&store, "mail_list_cached_folders", Some(args)).is_err());
}
