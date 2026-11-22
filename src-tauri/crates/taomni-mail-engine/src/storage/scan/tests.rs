use std::time::Duration;

use super::*;
use crate::storage::{account_root, list, object_path, prepare, remove_entries};

const ACCOUNT: &str = "mail-archive";
const RAW: &[u8] = b"Subject: Pending archive\r\n\r\nOriginal bytes\r\n";

fn databases() -> (tempfile::TempDir, Connection, Connection) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("account.db");
    let archive = Connection::open(&path).unwrap();
    crate::cache::init_mail_tables(&archive).unwrap();
    let cleanup = Connection::open(path).unwrap();
    cleanup.busy_timeout(Duration::ZERO).unwrap();
    (directory, archive, cleanup)
}

fn key(uid_validity: u32) -> ArchiveKey {
    ArchiveKey {
        folder: "INBOX".into(),
        uid: 1,
        uid_validity,
    }
}

#[test]
fn cleanup_cannot_write_between_the_guard_and_publication() {
    let (_directory, archive, cleanup) = databases();
    let target = key(10);
    let root = account_root(&archive, ACCOUNT).unwrap();
    let prepared = prepare(&root, RAW, || Ok(())).unwrap();

    let saved = publish_original(&archive, ACCOUNT, &target, prepared, || {
        assert_eq!(
            pause(&cleanup, ACCOUNT).unwrap_err().sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        Ok(())
    })
    .unwrap();

    let entries = list(&cleanup, ACCOUNT, 0).unwrap();
    assert_eq!(entries.len(), 1);
    let path = object_path(&root, &saved.hash).unwrap();
    assert!(path.is_file());
    assert_eq!(remove_entries(&cleanup, ACCOUNT, &entries).unwrap(), 1);
    assert!(!path.exists());
}

#[test]
fn paused_and_cleaned_targets_are_not_published_when_the_scan_retries() {
    let (_directory, archive, cleanup) = databases();
    let root = account_root(&archive, ACCOUNT).unwrap();
    let target = key(10);
    let pending = || prepare(&root, RAW, || Ok(())).unwrap();
    let prepared = pending();
    let path = object_path(&root, &prepared.hash).unwrap();

    pause(&cleanup, ACCOUNT).unwrap();
    assert!(begin(&archive, ACCOUNT, false).unwrap());
    assert_eq!(
        publish_original(&archive, ACCOUNT, &target, prepared, || Ok(())).unwrap_err(),
        PAUSED
    );
    skip(&cleanup, ACCOUNT, &target).unwrap();
    assert!(!begin(&archive, ACCOUNT, true).unwrap());
    assert!(
        publish_original(&archive, ACCOUNT, &target, pending(), || Ok(()))
            .unwrap_err()
            .contains("cleaned up")
    );
    assert!(!path.exists());
    assert!(list(&archive, ACCOUNT, 0).unwrap().is_empty());

    publish_original(&archive, ACCOUNT, &key(11), pending(), || Ok(())).unwrap();
    assert!(path.is_file());
    let entries = list(&archive, ACCOUNT, 0).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uid_validity, 11);
}
