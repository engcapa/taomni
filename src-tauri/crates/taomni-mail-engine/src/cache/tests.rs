use super::*;
use crate::{
    MailFolder,
    imap_sync::{FolderStepOutcome, MailSyncMode, Watermark},
};

#[test]
fn folder_step_keeps_current_list_metadata_across_a_subscription_change() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let mut listed = MailFolder {
        account_id: "acct".into(),
        name: "Archive".into(),
        delimiter: Some("/".into()),
        flags: vec!["\\Archive".into(), "\\Subscribed".into()],
        ..Default::default()
    };
    upsert_folder(&conn, &listed).unwrap();
    let outcome = FolderStepOutcome {
        folder: MailFolder {
            delimiter: None,
            flags: vec!["\\Seen".into()],
            total: Some(1),
            ..listed.clone()
        },
        mode: MailSyncMode::Catchup,
        messages: Vec::new(),
        vanished: Vec::new(),
        flag_updates: Vec::new(),
        watermark: Watermark::default(),
        highest_modseq: None,
        reconciled: false,
        uid_validity_reset: false,
        remaining: 0,
        more: false,
        new_unseen: 0,
    };
    let cache = MailCacheSettings::default();
    let cached = apply_folder_step(&conn, "acct", &outcome, &cache, 1)
        .unwrap()
        .folder
        .unwrap();
    assert_eq!(cached.flags, listed.flags);
    assert_eq!(cached.delimiter.as_deref(), Some("/"));
    assert_eq!(cached.total, Some(1));

    listed.flags.pop();
    upsert_folder(&conn, &listed).unwrap();
    let cached = apply_folder_step(&conn, "acct", &outcome, &cache, 2)
        .unwrap()
        .folder
        .unwrap();
    assert_eq!(cached.flags, ["\\Archive"]);
}

#[test]
fn migration_is_idempotent_and_keeps_rows() {
    let conn = Connection::open_in_memory().unwrap();
    // A pre-watermark schema with a saved message, before any application
    // has initialized the mailbox engine.
    conn.execute_batch("CREATE TABLE mail_messages (
        account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
        message_id TEXT, subject TEXT NOT NULL DEFAULT '', from_name TEXT, from_addr TEXT,
        to_json TEXT DEFAULT '[]', cc_json TEXT DEFAULT '[]', date_ts INTEGER,
        flags_json TEXT NOT NULL DEFAULT '[]', has_attachments INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0, attachments_json TEXT NOT NULL DEFAULT '[]',
        snippet TEXT, raw_size INTEGER, body_text TEXT, body_html TEXT, body_cached_at INTEGER,
        updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, folder, uid)
    );
    INSERT INTO mail_messages(account_id, folder, uid, subject, body_text, body_cached_at, updated_at)
    VALUES ('legacy', 'INBOX', 5, 'Retained', 'Saved body', 1, 1);").unwrap();
    init_mail_tables(&conn).unwrap();
    init_mail_tables(&conn).unwrap();

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, MAIL_SCHEMA_VERSION);
    assert_eq!(
        list_cached_messages(&conn, "legacy", "INBOX", 10, 0).unwrap()[0].subject,
        "Retained"
    );
    assert_eq!(
        get_cached_body(&conn, "legacy", "INBOX", 5)
            .unwrap()
            .unwrap()
            .text
            .as_deref(),
        Some("Saved body")
    );
}

#[test]
fn purge_cached_folder_removes_folder_and_subfolders_only() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    for name in ["Parent_%", "Parent_%/Child", "ParentX/Child", "Parent_%X"] {
        upsert_message(
            &conn,
            &crate::parse_body_message("acct", name, 1, None, b"Subject: Cached\r\n\r\nbody", 4096),
        )
        .unwrap();
        upsert_folder(
            &conn,
            &MailFolder {
                account_id: "acct".into(),
                name: name.into(),
                display_name: name.into(),
                delimiter: Some("/".into()),
                flags: vec![],
                uid_validity: None,
                uid_next: None,
                total: None,
                unread: None,
                updated_at: 1,
                ..MailFolder::default()
            },
        )
        .unwrap();
    }

    purge_cached_folder(&conn, "acct", "Parent_%").unwrap();

    let names = list_cached_folders(&conn, "acct")
        .unwrap()
        .into_iter()
        .map(|f| f.name)
        .collect::<Vec<_>>();
    assert!(names.contains(&"ParentX/Child".to_string()));
    assert!(names.contains(&"Parent_%X".to_string()));
    assert!(!names.contains(&"Parent_%".to_string()));
    assert!(!names.contains(&"Parent_%/Child".to_string()));
    assert_eq!(
        list_cached_messages(&conn, "acct", "Parent_%", 20, 0)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        list_cached_messages(&conn, "acct", "Parent_%/Child", 20, 0)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        list_cached_messages(&conn, "acct", "ParentX/Child", 20, 0)
            .unwrap()
            .len(),
        1
    );
}
