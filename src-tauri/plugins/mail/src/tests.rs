use std::{collections::BTreeSet, fs};

use rusqlite::Connection;
use serde_json::{Value, json};
use taomni_mail_engine::{
    MailFolder,
    cache::{init_mail_tables, upsert_folder, upsert_message},
    database::mail_db_file_stem,
    drafts::save_mail_draft,
    parse_body_message,
};
use taomni_plugin_api::ErrorCode;

use super::{commands, host_config, store::Store};

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
        commands::invoke(
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
        commands::invoke(&store, "mail_list_cached_folders", Some(query.clone())).unwrap(),
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

    let folders = commands::invoke(&store, "mail_list_cached_folders", Some(query)).unwrap();
    assert_eq!(folders[0]["name"], "INBOX");
    assert_eq!(folders[0]["cachedCount"], 1);
    let message = json!({"accountId":"saved-mail","folder":"INBOX","uid":5});
    let body = commands::invoke(&store, "mail_get_cached_body", Some(message)).unwrap();
    assert!(
        body["text"]
            .as_str()
            .unwrap()
            .contains("Saved message body")
    );
    assert_eq!(
        commands::invoke(
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
fn request_cannot_supply_a_database_path_and_oversized_bodies_get_an_rpc_error() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(&profile.path().canonicalize().unwrap());
    let path = json!({"accountId":"saved","path":"taomni.db"});
    assert_eq!(
        commands::invoke(&store, "mail_list_cached_folders", Some(path))
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
        commands::invoke(&store, "mail_get_cached_body", Some(args))
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
    assert!(commands::invoke(&store, "mail_list_cached_folders", Some(args.clone())).is_err());

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
    assert!(commands::invoke(&store, "mail_list_cached_folders", Some(args)).is_err());
}
