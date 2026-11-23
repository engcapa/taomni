use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::de::DeserializeOwned;
use taomni_mail_api::{
    message::{MailFolder, MailMessageHeader},
    search::{MailSearchField, MailSearchQuery},
};
use taomni_mail_engine::{
    cache::{init_mail_tables, upsert_folder, upsert_message},
    database::{mail_db_file_stem, redirect_path},
    parse_body_message,
};

use super::*;

const ACCOUNT: &str = "imap-cache-read";

fn database(directory: &Path, account: &str) -> PathBuf {
    directory.join(format!("{}.db", mail_db_file_stem(account)))
}

fn call<T: DeserializeOwned>(path: &Path, query: CacheQuery) -> T {
    let request = CacheQueryRequest {
        account_id: ACCOUNT.into(),
        database: path.to_owned(),
        query,
    };
    let reply = execute(request, CancellationToken::new()).unwrap();
    serde_json::from_slice(&reply).unwrap()
}

fn add(db: &Connection, account: &str, folder: &str, uid: u32, subject: &str) {
    upsert_folder(
        db,
        &MailFolder {
            account_id: account.into(),
            name: folder.into(),
            uid_validity: Some(9),
            ..Default::default()
        },
    )
    .unwrap();
    let mime = format!("Subject: {subject}\r\n\r\nBody for {subject}\r\n");
    let mut message = parse_body_message(account, folder, uid, None, mime.as_bytes(), 1024);
    message.header.date_ts = Some(i64::from(uid));
    upsert_message(db, &message).unwrap();
}

#[test]
fn reads_the_archived_original_before_the_optional_body_cache() {
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory.path().canonicalize().unwrap(), ACCOUNT);
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    add(&db, ACCOUNT, "INBOX", 3, "Cached copy");
    add(&db, ACCOUNT, "INBOX", 4, "Cached only");
    add(&db, "other-account", "INBOX", 5, "Other account");
    let raw = b"Subject: Exact original\r\n\r\nOriginal offline mail\r\n";
    storage::store(&db, ACCOUNT, "INBOX", 3, 9, &raw[..]).unwrap();

    let read = |uid, cache_enabled| {
        call::<Option<MailMessageBody>>(
            &path,
            CacheQuery::Body {
                folder: "INBOX".into(),
                uid,
                cache_enabled,
            },
        )
    };
    for cache_enabled in [false, true] {
        let body = read(3, cache_enabled).unwrap();
        assert_eq!(body.account_id, ACCOUNT);
        assert_eq!(body.folder, "INBOX");
        assert_eq!(body.uid, 3);
        assert_eq!(body.source, "archive");
        assert_eq!(body.subject, "Exact original");
        assert!(body.text.unwrap().contains("Original offline mail"));
    }
    assert_eq!(read(4, true).unwrap().source, "cache");
    assert!(read(4, false).is_none());
    assert!(read(5, true).is_none());
}

#[test]
fn reads_account_scoped_folders_message_pages_and_search_from_current_wal() {
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory.path().canonicalize().unwrap(), ACCOUNT);
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    add(&db, ACCOUNT, "INBOX", 1, "Subject 100%");
    add(&db, ACCOUNT, "INBOX", 2, "Subject 100_");
    add(&db, ACCOUNT, "INBOX", 3, "Newest page");
    add(&db, ACCOUNT, "Archive", 4, "Archived 100%");
    add(&db, "other-account", "INBOX", 5, "Other account 100%");
    let mut wal_path = path.as_os_str().to_owned();
    wal_path.push("-wal");
    let prior_wal = std::fs::read(&wal_path).unwrap();

    let folders: Vec<MailFolder> = call(&path, CacheQuery::Folders);
    assert_eq!(
        folders
            .iter()
            .map(|row| row.name.as_str())
            .collect::<Vec<_>>(),
        ["INBOX", "Archive"]
    );
    assert_eq!(folders[0].cached_count, Some(3));
    assert_eq!(folders[1].uid_validity, Some(9));
    let older: Vec<MailMessageHeader> = call(
        &path,
        CacheQuery::Messages {
            folder: "INBOX".into(),
            limit: 1,
            offset: 1,
        },
    );
    assert_eq!(older.iter().map(|row| row.uid).collect::<Vec<_>>(), [2]);
    let hits: Vec<MailMessageHeader> = call(
        &path,
        CacheQuery::Search(MailSearchQuery {
            text: "100%".into(),
            field: MailSearchField::Subject,
            ..Default::default()
        }),
    );
    assert_eq!(hits.iter().map(|row| row.uid).collect::<Vec<_>>(), [4, 1]);
    let scoped: Vec<MailMessageHeader> = call(
        &path,
        CacheQuery::Search(MailSearchQuery {
            text: "100%".into(),
            folder: Some("INBOX".into()),
            field: MailSearchField::Subject,
            ..Default::default()
        }),
    );
    assert_eq!(scoped.iter().map(|row| row.uid).collect::<Vec<_>>(), [1]);
    assert_eq!(std::fs::read(&wal_path).unwrap(), prior_wal);
}

#[test]
fn rejects_the_wrong_account_a_relocated_cache_and_cancelled_work() {
    let directory = tempfile::tempdir().unwrap();
    let directory = directory.path().canonicalize().unwrap();
    let path = database(&directory, ACCOUNT);
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    let request = |database| CacheQueryRequest {
        account_id: ACCOUNT.into(),
        database,
        query: CacheQuery::Folders,
    };

    let wrong = database(&directory, "other-account");
    let error = execute(request(wrong.clone()), CancellationToken::new()).unwrap_err();
    assert_eq!(error.message, "Invalid Mail archive storage path");
    assert!(!wrong.exists());

    std::fs::write(redirect_path(&path), b"relocated").unwrap();
    let error = execute(request(path.clone()), CancellationToken::new()).unwrap_err();
    assert!(error.message.contains("Mail storage moved"));

    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = execute(request(path), cancellation).unwrap_err();
    assert_eq!(error.code, ErrorCode::RequestCancelled.as_i32());
}

#[test]
fn oversized_results_are_rejected_as_whole_pages() {
    assert_eq!(encode(&["1234"], 8).unwrap(), br#"["1234"]"#);
    let error = encode(&["1234"], 7).unwrap_err();
    assert!(error.message.contains("Mail cache result is too large"));
}
