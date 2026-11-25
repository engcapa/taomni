use super::*;
use taomni_mail_api::archive_index::{ArchiveEntry, ArchivePage, ArchiveQuery, SearchField};

#[test]
fn reads_the_current_index_from_a_custom_cache() {
    let profile = tempfile::tempdir().unwrap();
    let custom_cache = tempfile::tempdir().unwrap();
    let account = "custom-account";
    let path = custom_cache
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(account)));
    let db = Connection::open(&path).unwrap();
    storage::init_tables(&db).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    db.execute(
        "INSERT INTO mail_full_messages VALUES(?1,'INBOX',12,3,'hash',256,128,123,?2)",
        [
            account,
            r#"{"subject":"发票 100%","from":{"address":"from@example.com"}}"#,
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO mail_full_messages VALUES('other-account','INBOX',13,3,'other',1,1,123,?1)",
        [r#"{"subject":"发票 100%"}"#],
    )
    .unwrap();

    let store = Store::new(profile.path());
    let mut request = ArchiveIndexRequest {
        account_id: account.into(),
        source: ArchiveIndexSource::AccountCache {
            database: path.clone(),
        },
        action: ArchiveIndexAction::Find {
            query: ArchiveQuery {
                text: "票 100%".into(),
                field: SearchField::Subject,
                ..Default::default()
            },
            offset: 200,
        },
    };
    let read: ArchivePage =
        serde_json::from_slice::<Result<_, String>>(&execute(&store, &request).unwrap())
            .unwrap()
            .unwrap();
    assert_eq!(read.total, 1);
    assert_eq!(read.offset, 0);
    assert_eq!(read.stored_bytes, 128);
    assert_eq!(read.entries[0].entry.subject, "发票 100%");
    assert_eq!(read.entries[0].from, "from@example.com");

    db.execute(
        "DELETE FROM mail_full_messages WHERE account_id=?1",
        [account],
    )
    .unwrap();
    request.action = ArchiveIndexAction::List { offset: 0 };
    let after: Vec<ArchiveEntry> =
        serde_json::from_slice::<Result<_, String>>(&execute(&store, &request).unwrap())
            .unwrap()
            .unwrap();
    assert!(after.is_empty());
    assert!(!profile.path().join("plugins").exists());
    assert!(open_account_cache(&path, "other-account").is_err());
}

#[test]
fn empty_module_archive_keeps_query_validation() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(profile.path());
    let mut request = ArchiveIndexRequest {
        account_id: "module-account".into(),
        source: ArchiveIndexSource::ModuleData,
        action: ArchiveIndexAction::Find {
            query: ArchiveQuery::default(),
            offset: 20,
        },
    };
    let empty: ArchivePage =
        serde_json::from_slice::<Result<_, String>>(&execute(&store, &request).unwrap())
            .unwrap()
            .unwrap();
    assert_eq!(empty.offset, 0);
    assert_eq!(empty.total, 0);
    assert!(empty.entries.is_empty());
    request.action = ArchiveIndexAction::Find {
        query: ArchiveQuery {
            min_size: Some(-1),
            ..Default::default()
        },
        offset: 0,
    };
    let invalid =
        serde_json::from_slice::<Result<ArchivePage, String>>(&execute(&store, &request).unwrap())
            .unwrap();
    assert_eq!(
        invalid.err().as_deref(),
        Some("Enter a valid message size range")
    );
}
