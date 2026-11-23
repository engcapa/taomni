use super::*;
use rusqlite::Connection;
use taomni_mail_api::archive_index::ArchiveKey;
use taomni_mail_engine::{
    MailFolder,
    cache::{init_mail_tables, upsert_folder, upsert_message},
    database::{mail_db_file_stem, redirect_path},
    parse_body_message, storage,
};

const ACCOUNT: &str = "archive-custom";
const ORIGINAL: &[u8] = b"Subject: Verified original\r\n\r\nOffline message\r\n";

#[test]
fn commits_one_verified_original_under_the_current_archive_policy() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let path = root.join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    let key = ArchiveKey {
        folder: "INBOX".into(),
        uid: 21,
        uid_validity: 6,
    };
    upsert_folder(
        &db,
        &MailFolder {
            account_id: ACCOUNT.into(),
            name: key.folder.clone(),
            uid_validity: Some(key.uid_validity),
            ..Default::default()
        },
    )
    .unwrap();
    upsert_message(
        &db,
        &parse_body_message(ACCOUNT, &key.folder, key.uid, None, ORIGINAL, 1024),
    )
    .unwrap();
    let mailbox = storage::account_root(&db, ACCOUNT).unwrap();
    let stage = || {
        storage::prepare(&mailbox, ORIGINAL, || Ok(()))
            .unwrap()
            .stage()
            .unwrap()
    };

    let (_guard, mut staged) = stage();
    staged.filename = "../outside".into();
    let request = |staged| PublishArchiveOriginal {
        account_id: ACCOUNT.into(),
        cache_database: path.clone(),
        key: key.clone(),
        staged,
    };
    assert_eq!(
        publish_request(request(staged), || Ok(())).unwrap_err(),
        "Invalid staged Mail archive filename"
    );
    scan::pause(&db, ACCOUNT).unwrap();
    let (_guard, staged) = stage();
    assert_eq!(
        publish_request(request(staged), || Ok(())).unwrap_err(),
        scan::PAUSED
    );
    assert!(
        storage::lookup(&db, ACCOUNT, &key.folder, key.uid)
            .unwrap()
            .is_none()
    );

    assert!(!scan::begin(&db, ACCOUNT, true).unwrap());
    let (_guard, staged) = stage();
    assert_eq!(
        publish_request(request(staged), || Err("cancelled".into())).unwrap_err(),
        "cancelled"
    );
    assert!(
        storage::lookup(&db, ACCOUNT, &key.folder, key.uid)
            .unwrap()
            .is_none()
    );

    let (_guard, staged) = stage();
    std::fs::write(redirect_path(&path), b"move in progress").unwrap();
    assert_eq!(
        publish_request(request(staged), || Ok(())).unwrap_err(),
        "Mail storage moved before this archive operation. Retry storage",
    );
    assert!(
        storage::lookup(&db, ACCOUNT, &key.folder, key.uid)
            .unwrap()
            .is_none()
    );
    std::fs::remove_file(redirect_path(&path)).unwrap();

    let (_guard, staged) = stage();
    publish_request(request(staged), || Ok(())).unwrap();
    let original = storage::open(&db, ACCOUNT, &key.folder, key.uid)
        .unwrap()
        .unwrap();
    assert_eq!(original.read().unwrap(), ORIGINAL);
    let archive = storage::query::query(&db, ACCOUNT, &Default::default(), 0).unwrap();
    assert_eq!(archive.total, 1);
    assert_eq!(archive.entries[0].entry.uid, key.uid);
    assert_eq!(archive.entries[0].entry.subject, "Verified original");
}
