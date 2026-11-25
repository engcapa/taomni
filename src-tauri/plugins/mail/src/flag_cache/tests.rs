use std::{cell::Cell, path::Path};

use rusqlite::Connection;
use taomni_mail_api::{ImapFlagUpdate, message::MailFolder};
use taomni_mail_engine::{
    cache::{cached_header, init_mail_tables, list_cached_folders, upsert_folder, upsert_message},
    database::mail_db_file_stem,
    parse_body_message,
};

use super::*;

#[test]
fn confirmed_flags_and_server_unread_count_commit_to_the_same_cache() {
    let account = "imap-flags";
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(account)));
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    upsert_folder(
        &db,
        &MailFolder {
            account_id: account.into(),
            name: "INBOX".into(),
            unread: Some(8),
            ..MailFolder::default()
        },
    )
    .unwrap();
    let raw = b"Subject: Retained\r\n\r\nMessage body";
    let message = parse_body_message(account, "INBOX", 9, None, raw, raw.len());
    upsert_message(&db, &message).unwrap();

    let update = |database: &Path, action| ImapFlagPublication {
        account_id: account.into(),
        database: database.to_owned(),
        action,
    };
    apply(
        update(
            &path,
            ImapFlagCacheAction::Update {
                flags: ImapFlagUpdate {
                    folder: "INBOX".into(),
                    uids: vec![9],
                    add: vec!["\\Flagged".into()],
                    remove: Vec::new(),
                },
            },
        ),
        &|| Ok(()),
    )
    .unwrap();
    let read = || {
        update(
            &path,
            ImapFlagCacheAction::Read {
                folder: "INBOX".into(),
                uids: vec![9],
                remaining: Some(3),
            },
        )
    };
    let row_flags = || {
        cached_header(&db, account, "INBOX", 9)
            .unwrap()
            .unwrap()
            .flags
    };
    let unread = || list_cached_folders(&db, account).unwrap()[0].unread;
    let checks = Cell::new(0);
    let cancelled = apply(read(), &|| {
        checks.set(checks.get() + 1);
        if checks.get() == 4 {
            Err(RpcError::from_code(ErrorCode::RequestCancelled))
        } else {
            Ok(())
        }
    });
    assert_eq!(
        cancelled.err().unwrap().code,
        ErrorCode::RequestCancelled.as_i32()
    );
    assert_eq!(row_flags(), ["\\Flagged"]);
    assert_eq!(unread(), Some(8));

    apply(read(), &|| Ok(())).unwrap();
    assert_eq!(row_flags(), ["\\Flagged", "\\Seen"]);
    assert_eq!(unread(), Some(3));
}
