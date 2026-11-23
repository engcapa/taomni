use std::{
    cell::Cell,
    path::{Path, PathBuf},
};

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    archive_index::ArchiveKey,
    imap_sync::{FolderStepOutcome, FolderSyncState, MailSyncMode, Watermark},
    message::MailFolder,
};
use taomni_mail_engine::{
    cache::{init_mail_tables, list_cached_folders, list_cached_messages, upsert_folder},
    database::mail_db_file_stem,
    parse_body_message, storage,
};

use super::*;

const ACCOUNT: &str = "imap-archive";
const ORIGINAL: &[u8] = b"Subject: Local original\r\n\r\nRetained body\r\n";

fn cache() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let database = root
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    init_mail_tables(&Connection::open(&database).unwrap()).unwrap();
    (root, database)
}

fn request(database: &Path, action: ArchiveScanAction) -> ArchiveScanRequest {
    ArchiveScanRequest {
        account_id: ACCOUNT.into(),
        database: database.into(),
        action,
    }
}

fn action<T: DeserializeOwned>(database: &Path, action: ArchiveScanAction) -> T {
    serde_json::from_slice(&execute(request(database, action), &|| Ok(())).unwrap()).unwrap()
}

fn header(uid: u32, validity: u32) -> ArchiveScanAction {
    ArchiveScanAction::CommitHeaders {
        outcome: Box::new(FolderStepOutcome {
            folder: MailFolder {
                account_id: ACCOUNT.into(),
                name: "INBOX".into(),
                uid_validity: Some(validity),
                ..Default::default()
            },
            mode: MailSyncMode::Initial,
            messages: vec![parse_body_message(
                ACCOUNT,
                "INBOX",
                uid,
                None,
                ORIGINAL,
                ORIGINAL.len(),
            )],
            vanished: Vec::new(),
            flag_updates: Vec::new(),
            watermark: Watermark {
                low: Some(uid),
                high: Some(uid),
                complete: true,
                needs_repair: false,
            },
            highest_modseq: None,
            reconciled: true,
            uid_validity_reset: false,
            remaining: 0,
            more: false,
            new_unseen: 1,
        }),
        body_recent_limit: 200,
        started_at_ms: 100,
    }
}

fn pending(database: &Path) -> (u32, Vec<u32>) {
    action(
        database,
        ArchiveScanAction::Pending {
            folder: "INBOX".into(),
        },
    )
}

#[test]
fn pause_survives_reopen_and_blocks_late_header_and_skip_commits_until_explicit_resume() {
    let (_root, database) = cache();
    let count: u32 = action(&database, header(7, 71));
    assert_eq!(count, 1);
    let state: FolderSyncState = action(
        &database,
        ArchiveScanAction::FolderState {
            folder: "INBOX".into(),
        },
    );
    assert_eq!(state.high, Some(7));
    assert_eq!(pending(&database), (71, vec![7]));

    action::<()>(&database, ArchiveScanAction::Pause);
    let status: ArchiveScanStatus = action(&database, ArchiveScanAction::Status);
    assert!(status.paused);
    assert!(action::<bool>(
        &database,
        ArchiveScanAction::Begin { resume: false }
    ));
    let key = ArchiveKey {
        folder: "INBOX".into(),
        uid: 7,
        uid_validity: 71,
    };
    for update in [header(8, 71), ArchiveScanAction::Skip { key: key.clone() }] {
        let error = execute(request(&database, update), &|| Ok(())).unwrap_err();
        assert_eq!(error.message, scan::PAUSED);
    }
    assert_eq!(pending(&database), (71, vec![7]));
    assert!(!action::<bool>(
        &database,
        ArchiveScanAction::Begin { resume: true }
    ));
    action::<()>(&database, ArchiveScanAction::Skip { key });
    assert_eq!(pending(&database), (71, vec![]));
}

#[test]
fn clear_is_atomic_and_account_scoped_and_retains_offline_originals() {
    let (_root, database) = cache();
    action::<u32>(&database, header(7, 71));
    let db = Connection::open(&database).unwrap();
    upsert_folder(
        &db,
        &MailFolder {
            account_id: "other".into(),
            name: "INBOX".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let key = ArchiveKey {
        folder: "INBOX".into(),
        uid: 7,
        uid_validity: 71,
    };
    let root = storage::account_root(&db, ACCOUNT).unwrap();
    let original = storage::prepare(&root, ORIGINAL, || Ok(())).unwrap();
    scan::publish_original(&db, ACCOUNT, &key, original, || Ok(())).unwrap();
    action::<()>(&database, ArchiveScanAction::Pause);

    let checks = Cell::new(0);
    assert!(
        execute(request(&database, ArchiveScanAction::ClearCache), &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 5 {
                Err(RpcError::from_code(ErrorCode::RequestCancelled))
            } else {
                Ok(())
            }
        })
        .is_err()
    );
    assert_eq!(list_cached_folders(&db, ACCOUNT).unwrap().len(), 1);
    assert_eq!(
        list_cached_messages(&db, ACCOUNT, "INBOX", 10, 0)
            .unwrap()
            .len(),
        1
    );

    let mutation = ProcessLock::try_at(&database, MAIL_MUTATION_LOCK)
        .unwrap()
        .unwrap();
    assert!(
        execute(
            request(&database, ArchiveScanAction::ClearCache),
            &|| Ok(())
        )
        .is_err()
    );
    drop(mutation);
    action::<()>(&database, ArchiveScanAction::ClearCache);
    assert!(list_cached_folders(&db, ACCOUNT).unwrap().is_empty());
    assert!(
        list_cached_messages(&db, ACCOUNT, "INBOX", 10, 0)
            .unwrap()
            .is_empty()
    );
    assert_eq!(list_cached_folders(&db, "other").unwrap().len(), 1);
    assert!(scan::is_paused(&db, ACCOUNT).unwrap());
    assert_eq!(
        storage::open(&db, ACCOUNT, "INBOX", 7)
            .unwrap()
            .unwrap()
            .read()
            .unwrap(),
        ORIGINAL
    );
}

#[test]
fn clearing_a_local_only_mailbox_is_rejected() {
    let (_root, database) = cache();
    action::<u32>(&database, header(7, 71));
    let db = Connection::open(&database).unwrap();
    db.execute(
        "INSERT INTO mail_pop3_uidl(account_id,uidl,fetched_at) VALUES(?1,'retained',0)",
        [ACCOUNT],
    )
    .unwrap();
    let error = execute(
        request(&database, ArchiveScanAction::ClearCache),
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        taomni_mail_api::archive_scan::POP3_CLEAR_ERROR
    );
    assert_eq!(list_cached_folders(&db, ACCOUNT).unwrap().len(), 1);
}
