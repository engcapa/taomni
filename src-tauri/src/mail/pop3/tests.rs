use super::connection::Pop3Client;
use super::connection::apop_digest;
use super::local_store::create_local_folder;
use super::local_store::delete_local;
use super::local_store::ensure_local_folders;
use super::local_store::has_local_store;
use super::local_store::insert_local;
use super::local_store::local_raw;
use super::local_store::move_local;
use super::local_store::rename_local_folder;
use super::synchronization::plan_round;
use super::synchronization::sync_inbox;
use crate::mail::MailAccountConfig;
use crate::mail::MailAuthMode;
use crate::mail::ResolvedMailAccount;
use crate::mail::list_cached_folders;
#[cfg(test)]
use crate::mail::pop3::fake;
use rusqlite::Connection;
use std::collections::HashMap;

use std::sync::{Arc, Mutex};

fn raw(subject: &str) -> Vec<u8> {
    format!(
            "From: Sender <s@example.com>\r\nTo: me@example.com\r\nSubject: {subject}\r\nDate: Tue, 14 Nov 2023 22:13:20 +0000\r\nMessage-ID: <{subject}@example.com>\r\n\r\n.leading dot line\r\nbody of {subject}\r\n"
        )
        .into_bytes()
}

fn account(port: u16) -> ResolvedMailAccount {
    let config: MailAccountConfig = serde_json::from_value(serde_json::json!({
        "sessionId": "pop",
        "emailAddress": "me@example.com",
        "incoming": "pop3",
        "imap": {"host": "127.0.0.1", "port": port, "security": "none", "username": "me"},
        "smtp": {"host": "127.0.0.1", "port": 1, "security": "none"}
    }))
    .unwrap();
    ResolvedMailAccount {
        config,
        auth_mode: MailAuthMode::Password,
        network_settings: None,
        imap_username: "me".into(),
        imap_password: "secret".into(),
        smtp_username: "me".into(),
        smtp_password: "secret".into(),
    }
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    super::super::init_mail_tables(&conn).unwrap();
    conn
}

#[test]
fn apop_matches_rfc1939_example() {
    assert_eq!(
        apop_digest("<1896.697170952@dbc.mtview.ca.us>", "tanstaaf"),
        "c4c9334bac560ecc979e58001b3e22fb"
    );
}

#[test]
fn plans_new_downloads_and_expired_deletes() {
    let listing = vec![
        (1, "a".to_string()),
        (2, "b".to_string()),
        (3, "c".to_string()),
    ];
    let known: HashMap<String, i64> = [("a".to_string(), 0), ("b".to_string(), 1_000_000)].into();
    let (fetch, deletes) = plan_round(&listing, &known, 10, Some(7), 1_000_000);
    assert_eq!(fetch, vec![(3, "c".to_string())]);
    assert_eq!(
        deletes,
        vec![1],
        "only mail downloaded more than 7 days ago"
    );
    let (_, keep) = plan_round(&listing, &known, 10, None, 1_000_000);
    assert!(keep.is_empty(), "no policy keeps everything on the server");
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_once_and_leaves_or_deletes() {
    let state = Arc::new(Mutex::new(fake::FakePop3State {
        messages: vec![("u1".into(), raw("one")), ("u2".into(), raw("two"))],
        ..Default::default()
    }));
    let port = fake::start(Arc::clone(&state));
    let account = account(port);
    let conn = db();
    let handle = tokio::runtime::Handle::current();
    let run = |conn: &Connection, leave: Option<u32>| {
        let mut client = Pop3Client::connect(&account, &handle).unwrap();
        let outcome = sync_inbox(&mut client, conn, "pop", leave).unwrap();
        client.quit().unwrap();
        outcome
    };

    let first = tokio::task::block_in_place(|| run(&conn, None));
    assert_eq!(first.messages.len(), 2);
    let body = local_raw(&conn, "pop", "INBOX", first.messages[0].header.uid)
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains("\r\n.leading dot line\r\n"),
        "dot-unstuffed"
    );
    assert!(first.messages.iter().any(|m| m.header.subject == "two"));

    // AC-65: a second sync downloads nothing again.
    state
        .lock()
        .unwrap()
        .messages
        .push(("u3".into(), raw("three")));
    let second = tokio::task::block_in_place(|| run(&conn, None));
    assert_eq!(second.messages.len(), 1);
    assert_eq!(second.messages[0].header.subject, "three");
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mail_messages WHERE account_id = 'pop' AND folder = 'INBOX'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(total, 3);

    // AC-66: "keep 0 days" deletes everything already downloaded.
    let third = tokio::task::block_in_place(|| run(&conn, Some(0)));
    assert_eq!(third.messages.len(), 0);
    assert_eq!(third.deleted_on_server, 3);
    assert_eq!(state.lock().unwrap().deleted.len(), 3);
    assert!(state.lock().unwrap().messages.is_empty());
}

#[test]
fn local_folders_move_copy_delete() {
    let conn = db();
    ensure_local_folders(&conn, "pop").unwrap();
    let a = insert_local(&conn, "pop", "INBOX", &raw("alpha"), &[]).unwrap();
    let b = insert_local(&conn, "pop", "INBOX", &raw("beta"), &["\\Seen"]).unwrap();
    assert_eq!((a.header.uid, b.header.uid), (1, 2));
    create_local_folder(&conn, "pop", "Projects").unwrap();
    assert_eq!(
        move_local(&conn, "pop", "INBOX", &[1], "Projects", false).unwrap(),
        1
    );
    assert_eq!(
        move_local(&conn, "pop", "INBOX", &[2], "Archive2", true).unwrap(),
        1
    );
    let folders = list_cached_folders(&conn, "pop").unwrap();
    let count = |name: &str| {
        folders
            .iter()
            .find(|f| f.name == name)
            .and_then(|f| f.total)
    };
    assert_eq!(count("INBOX"), Some(1));
    assert_eq!(count("Projects"), Some(1));
    assert!(local_raw(&conn, "pop", "Projects", 1).unwrap().is_some());
    assert_eq!(delete_local(&conn, "pop", "INBOX", Some(&[2])).unwrap(), 1);
    rename_local_folder(&conn, "pop", "Projects", "Work").unwrap();
    assert!(local_raw(&conn, "pop", "Work", 1).unwrap().is_some());
    assert!(has_local_store(&conn, "pop").unwrap());
}

#[test]
fn permanent_delete_retains_original_and_cleanup_never_reuses_its_uid() {
    let dir = tempfile::tempdir().unwrap();
    let conn = Connection::open(dir.path().join("qa-pop3.db")).unwrap();
    super::super::init_mail_tables(&conn).unwrap();
    ensure_local_folders(&conn, "pop").unwrap();
    let original = raw("retained");
    let first = insert_local(&conn, "pop", "INBOX", &original, &[]).unwrap();
    delete_local(&conn, "pop", "INBOX", Some(&[first.header.uid])).unwrap();
    let entries = super::super::storage::list(&conn, "pop", 0).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        super::super::storage::read_entry(&conn, "pop", &entries[0]).unwrap(),
        original
    );
    super::super::storage::remove_entries(&conn, "pop", &entries).unwrap();
    let next = insert_local(&conn, "pop", "INBOX", &raw("next"), &[]).unwrap();
    assert!(next.header.uid > first.header.uid);
    delete_local(&conn, "pop", "INBOX", Some(&[next.header.uid])).unwrap();
    let retained = super::super::storage::list(&conn, "pop", 0).unwrap();
    assert_eq!(
        retained.len(),
        1,
        "cleaning an old UID must not suppress a new email"
    );
    assert_eq!(retained[0].uid, next.header.uid);
}
