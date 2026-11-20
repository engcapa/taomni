use std::{collections::BTreeSet, fs, sync::Barrier, thread};

use rusqlite::Connection;
use serde_json::{Value, json};
use taomni_mail_engine::{
    MailFolder,
    cache::{init_mail_tables, upsert_folder, upsert_message},
    database::mail_db_file_stem,
    drafts::save_mail_draft,
    parse_body_message,
    pop3::local_store::{ensure_local_folders, insert_local},
    storage,
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
fn simultaneous_saves_publish_one_mailbox_and_keep_each_draft() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    for offset in [0, 8] {
        let start = Barrier::new(8);
        thread::scope(|scope| {
            for index in offset..offset + 8 {
                let store = &store;
                let start = &start;
                scope.spawn(move || {
                    let id = format!("draft-{index:02}");
                    start.wait();
                    let saved = invoke(
                        store,
                        "mail_save_draft",
                        Some(json!({"accountId":"mail-a","draft":{"id":id,"subject":id}})),
                    )
                    .unwrap();
                    assert_eq!(saved["id"], id);
                });
            }
        });
    }
    let drafts = invoke(
        &store,
        "mail_list_drafts",
        Some(json!({"accountId":"mail-a"})),
    )
    .unwrap();
    let ids = drafts
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    let expected = (0..16)
        .map(|index| format!("draft-{index:02}"))
        .collect::<Vec<_>>();
    assert_eq!(ids, expected.iter().map(String::as_str).collect());
    assert_eq!(
        profile
            .path()
            .join("plugins/mail/data")
            .read_dir()
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn address_book_writes_fail_cleanly_and_only_affect_the_selected_mailbox() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let error = invoke(
        &store,
        "mail_save_address_book_entry",
        Some(json!({"accountId":"mail-a","entry":{"emails":["invalid address"]}})),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidParams as i32);
    assert!(error.message.contains("not an email address"));
    assert_eq!(
        profile
            .path()
            .join("plugins/mail/data")
            .read_dir()
            .unwrap()
            .count(),
        0
    );

    let saved = invoke(
        &store,
        "mail_save_address_book_entry",
        Some(json!({
            "accountId":"mail-a",
            "entry":{"displayName":"Contact","emails":["contact@example.com"]}
        })),
    )
    .unwrap();
    let delete = |account| {
        invoke(
            &store,
            "mail_delete_address_book_entry",
            Some(json!({"accountId":account,"uid":saved["uid"]})),
        )
        .unwrap()
    };
    assert_eq!(delete("mail-b"), false);
    let suggestions = invoke(
        &store,
        "mail_search_contacts",
        Some(json!({"accountId":"mail-a","query":"contact"})),
    )
    .unwrap();
    assert_eq!(suggestions[0]["email"], "contact@example.com");
    assert_eq!(suggestions[0]["source"], "addressBook");
    assert_eq!(delete("mail-a"), true);
    assert_eq!(delete("mail-a"), false);
    assert_eq!(
        invoke(
            &store,
            "mail_list_address_book",
            Some(json!({"accountId":"mail-a"})),
        )
        .unwrap(),
        json!([])
    );
}

#[test]
fn cancellation_during_first_draft_save_leaves_no_database() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let cancelled = std::cell::Cell::new(false);
    let result = store.mutate(
        "cancelled",
        true,
        &|| {
            if cancelled.get() {
                return Err(taomni_plugin_api::RpcError::from_code(
                    ErrorCode::RequestCancelled,
                ));
            }
            Ok(())
        },
        |database| {
            let draft = serde_json::from_value(json!({"id":"cancelled"})).unwrap();
            save_mail_draft(database, "cancelled", draft).unwrap();
            cancelled.set(true);
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
    let stored_at = 1_710_000_010_i64;
    db.execute(
        "UPDATE mail_full_messages SET stored_at = ?1 WHERE account_id = ?2 AND uid = 5",
        rusqlite::params![stored_at, account],
    )
    .unwrap();
    let read = || {
        invoke(
            &store,
            "mail_get_cached_body",
            Some(json!({"accountId":account,"folder":"INBOX","uid":5})),
        )
    };
    let body = read().unwrap();
    assert_eq!(body["source"], "archive");
    assert_eq!(body["cachedAt"], stored_at);
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
fn pop3_original_restores_the_body_when_only_headers_are_cached() {
    let profile = tempfile::tempdir().unwrap();
    let root = profile.path().canonicalize().unwrap();
    let store = Store::new(&root);
    let data = root.join("plugins/mail/data");
    fs::create_dir_all(&data).unwrap();
    let account = "local-pop3";
    let database = data.join(format!("{}.db", mail_db_file_stem(account)));
    let db = Connection::open(&database).unwrap();
    init_mail_tables(&db).unwrap();
    ensure_local_folders(&db, account).unwrap();
    let raw = b"Subject: Local original\r\n\r\nPOP3 body retained in SQLite\r\n";
    let uid = insert_local(&db, account, "INBOX", raw, &[])
        .unwrap()
        .header
        .uid;
    db.execute(
        "UPDATE mail_messages SET body_text = NULL, body_html = NULL, body_cached_at = NULL
         WHERE account_id = ?1 AND uid = ?2",
        rusqlite::params![account, uid],
    )
    .unwrap();
    drop(db);
    let before = fs::read(&database).unwrap();
    let body = invoke(
        &store,
        "mail_get_cached_body",
        Some(json!({"accountId":account,"folder":"INBOX","uid":uid})),
    )
    .unwrap();
    assert_eq!(body["subject"], "Local original");
    assert!(body["cachedAt"].is_null());
    assert!(
        body["text"]
            .as_str()
            .unwrap()
            .contains("POP3 body retained in SQLite")
    );
    assert_eq!(fs::read(database).unwrap(), before);
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
