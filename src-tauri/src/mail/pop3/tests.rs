use super::connection::Pop3Client;
use super::local_raw;
use super::sync_inbox;
use crate::mail::MailAccountConfig;
use crate::mail::MailAuthMode;
use crate::mail::ResolvedMailAccount;
#[cfg(test)]
use crate::mail::pop3::fake;
use rusqlite::Connection;

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
        let outcome = sync_inbox(&mut client.session, conn, "pop", leave).unwrap();
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
