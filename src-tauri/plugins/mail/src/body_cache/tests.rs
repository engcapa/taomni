use std::{cell::Cell, path::PathBuf};

use rusqlite::Connection;
use taomni_mail_engine::{
    cache::{cached_header, get_cached_body, init_mail_tables, upsert_message},
    database::mail_db_file_stem,
    parse_body_message,
};

use super::*;

const ACCOUNT: &str = "body-cache-account";

fn seed_cache() -> (tempfile::TempDir, PathBuf, MailMessageCached) {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    let raw = b"Subject: Current body\r\nMessage-ID: <body@example.test>\r\n\r\nRetained body";
    let body = parse_body_message(ACCOUNT, "INBOX", 7, None, raw, raw.len());
    let mut header = body.clone();
    header.body_cached_at = None;
    header.body_text = None;
    header.body_html = None;
    upsert_message(&db, &header).unwrap();
    db.execute(
        "INSERT INTO mail_folders (account_id, name, uid_validity, updated_at)
         VALUES (?1, 'INBOX', 10, 1)",
        [ACCOUNT],
    )
    .unwrap();
    (root, path, body)
}

fn request(
    path: PathBuf,
    message: MailMessageCached,
    source: ImapBodyCacheSource,
) -> ImapBodyPublication<MailMessageCached> {
    ImapBodyPublication {
        database: path,
        account_id: ACCOUNT.into(),
        observed_at: 100,
        source,
        message,
    }
}

#[test]
fn a_stale_prefetch_is_rejected_and_a_current_fetch_only_fills_the_body() {
    let (_root, path, body) = seed_cache();
    let db = Connection::open(&path).unwrap();
    db.execute(
        "UPDATE mail_messages SET flags_json=?1, flags_local_at=120",
        [serde_json::json!(["\\Seen"]).to_string()],
    )
    .unwrap();
    assert!(
        !apply(
            request(
                path.clone(),
                body.clone(),
                ImapBodyCacheSource::Prefetched {
                    uid_validity: Some(9)
                },
            ),
            &|| Ok(()),
        )
        .unwrap()
    );
    assert!(get_cached_body(&db, ACCOUNT, "INBOX", 7).unwrap().is_none());

    assert!(
        apply(
            request(
                path,
                body,
                ImapBodyCacheSource::Prefetched {
                    uid_validity: Some(10)
                },
            ),
            &|| Ok(()),
        )
        .unwrap()
    );
    let header = cached_header(&db, ACCOUNT, "INBOX", 7).unwrap().unwrap();
    assert_eq!(header.flags, ["\\Seen"]);
    assert_eq!(
        get_cached_body(&db, ACCOUNT, "INBOX", 7)
            .unwrap()
            .unwrap()
            .text
            .as_deref(),
        Some("Retained body"),
    );
}

#[test]
fn a_cancelled_open_body_transaction_never_publishes() {
    let (_root, path, body) = seed_cache();
    let checks = Cell::new(0);
    let stopped = apply(
        request(path.clone(), body.clone(), ImapBodyCacheSource::Opened),
        &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 4 {
                Err(RpcError::from_code(ErrorCode::RequestCancelled))
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(
        stopped.err().unwrap().code,
        ErrorCode::RequestCancelled.as_i32()
    );
    let db = Connection::open(&path).unwrap();
    assert!(get_cached_body(&db, ACCOUNT, "INBOX", 7).unwrap().is_none());

    assert!(apply(request(path, body, ImapBodyCacheSource::Opened), &|| Ok(())).unwrap());
    assert!(get_cached_body(&db, ACCOUNT, "INBOX", 7).unwrap().is_some());
}
