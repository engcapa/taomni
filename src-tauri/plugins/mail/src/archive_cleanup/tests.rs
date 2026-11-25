use std::cell::Cell;
use std::path::Path;

use taomni_mail_api::archive_index::{ArchiveKey, ArchiveQuery};
use taomni_mail_engine::{
    cache::init_mail_tables,
    database::mail_db_file_stem,
    storage::{self, account_root},
};

use super::*;

const ACCOUNT: &str = "signed-archive-cleanup";
const FOLDER: &str = "INBOX";

fn add(db: &Connection, uid: u32, raw: &[u8]) -> String {
    storage::store(db, ACCOUNT, FOLDER, uid, 9, raw)
        .unwrap()
        .hash
}

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let database = directory
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    let db = Connection::open(&database).unwrap();
    init_mail_tables(&db).unwrap();
    (directory, database)
}

fn request(database: &Path, action: ArchiveIndexAction) -> ArchiveIndexRequest {
    ArchiveIndexRequest {
        account_id: ACCOUNT.to_owned(),
        source: ArchiveIndexSource::AccountCache {
            database: database.to_owned(),
        },
        action,
    }
}

fn call<T: serde::de::DeserializeOwned>(
    archive: &ArchivePreviews,
    path: &Path,
    action: ArchiveIndexAction,
) -> Result<T, String> {
    let bytes = archive
        .run(request(path, action), &|| Ok(()))
        .map_err(|error| error.message)?;
    serde_json::from_slice(&bytes).unwrap()
}

fn preview(uid: u32) -> ArchiveIndexAction {
    ArchiveIndexAction::Preview {
        selection: ArchiveSelection {
            query: None,
            keys: vec![ArchiveKey {
                folder: FOLDER.into(),
                uid,
                uid_validity: 9,
            }],
            excluded: Vec::new(),
        },
    }
}

fn confirm(preview: &CleanupPreview) -> ArchiveIndexAction {
    ArchiveIndexAction::Cleanup {
        token: preview.token.clone(),
    }
}

#[test]
fn rejects_stale_tokens_and_removes_only_confirmed_originals() {
    let (_directory, database) = fixture();
    let archive = ArchivePreviews::default();
    let db = Connection::open(&database).unwrap();
    let first = add(&db, 1, b"Subject: Shared original\r\n\r\nOne\r\n");
    let second = add(&db, 2, b"Subject: Remove original\r\n\r\nTwo\r\n");
    let root = account_root(&db, ACCOUNT).unwrap();
    drop(db);

    let stale: CleanupPreview = call(&archive, &database, preview(1)).unwrap();
    let frozen: CleanupPreview = call(
        &archive,
        &database,
        ArchiveIndexAction::Preview {
            selection: ArchiveSelection {
                query: Some(ArchiveQuery::default()),
                keys: Vec::new(),
                excluded: vec![ArchiveKey {
                    folder: FOLDER.into(),
                    uid: 1,
                    uid_validity: 9,
                }],
            },
        },
    )
    .unwrap();
    assert_eq!(frozen.count, 1);
    let db = Connection::open(&database).unwrap();
    let later = add(&db, 3, b"Subject: Arrived later\r\n\r\nThree\r\n");
    assert_eq!(
        call::<u64>(&archive, &database, confirm(&stale)).unwrap_err(),
        EXPIRED,
    );
    assert_eq!(
        call::<u64>(&archive, &database, confirm(&frozen)).unwrap(),
        1
    );
    assert_eq!(
        call::<u64>(&archive, &database, confirm(&frozen)).unwrap_err(),
        EXPIRED,
    );

    let remaining = storage::list(&db, ACCOUNT, 0).unwrap();
    assert_eq!(
        remaining.iter().map(|entry| entry.uid).collect::<Vec<_>>(),
        [3, 1]
    );
    assert!(scan::is_paused(&db, ACCOUNT).unwrap());
    let original = |hash: &str| {
        root.join("objects")
            .join(&hash[..2])
            .join(format!("{hash}.eml.gz"))
    };
    assert!(!original(&second).exists());
    assert!(original(&first).exists());
    assert!(original(&later).exists());
}

#[test]
fn a_moved_or_restored_cache_invalidates_older_previews() {
    let (_directory, database) = fixture();
    let archive = ArchivePreviews::default();
    let db = Connection::open(&database).unwrap();
    add(&db, 1, b"Subject: Retained\r\n\r\nRestart\r\n");
    drop(db);
    let frozen: CleanupPreview = call(&archive, &database, preview(1)).unwrap();

    let relocated = tempfile::tempdir().unwrap();
    let moved = relocated
        .path()
        .canonicalize()
        .unwrap()
        .join(database.file_name().unwrap());
    fs::rename(&database, &moved).unwrap();
    assert_eq!(
        call::<u64>(&archive, &moved, confirm(&frozen)).unwrap_err(),
        EXPIRED
    );
    fs::rename(&moved, &database).unwrap();
    fs::write(
        database.with_extension("generation"),
        b"restored generation",
    )
    .unwrap();
    assert_eq!(
        call::<u64>(&archive, &database, confirm(&frozen)).unwrap_err(),
        EXPIRED
    );
    let db = Connection::open(&database).unwrap();
    assert_eq!(storage::list(&db, ACCOUNT, 0).unwrap().len(), 1);
    assert!(!scan::is_paused(&db, ACCOUNT).unwrap());
}

#[test]
fn cancellation_before_commit_preserves_the_selection_for_retry() {
    let (_directory, database) = fixture();
    let archive = ArchivePreviews::default();
    let db = Connection::open(&database).unwrap();
    add(&db, 1, b"Subject: Retry\r\n\r\nBody\r\n");
    let frozen: CleanupPreview = call(&archive, &database, preview(1)).unwrap();

    let mut writer = Connection::open(&database).unwrap();
    let calls = Cell::new(0);
    let check = || {
        calls.set(calls.get() + 1);
        if calls.get() == 3 {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    };
    assert_eq!(
        archive
            .cleanup(
                &mut writer,
                database.clone(),
                ACCOUNT,
                &frozen.token,
                &check
            )
            .unwrap_err(),
        "cancelled",
    );
    assert_eq!(storage::list(&db, ACCOUNT, 0).unwrap().len(), 1);
    assert!(!scan::is_paused(&db, ACCOUNT).unwrap());
    drop(writer);
    assert_eq!(
        call::<u64>(&archive, &database, confirm(&frozen)).unwrap(),
        1
    );
    assert!(storage::list(&db, ACCOUNT, 0).unwrap().is_empty());
}
