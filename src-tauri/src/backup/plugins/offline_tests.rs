use super::super::snapshot_context::SnapshotContext;
use super::{contracts::PluginDataFileKind, offline, test_support::write};
use rusqlite::Connection;
use std::fs;
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};

#[test]
fn offline_snapshot_contains_committed_wal_and_unknown_files_without_source_migration() {
    let dir = tempfile::tempdir().unwrap();
    let profile = ProfileRoot::prepare(dir.path()).unwrap();
    let data = profile.path().join("plugins/hello/data");
    fs::create_dir_all(&data).unwrap();
    let database = data.join("store.opaque");
    let conn = Connection::open(&database).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE marker(value); INSERT INTO marker VALUES('committed WAL');").unwrap();
    let database_before = fs::read(&database).unwrap();
    let wal_before = fs::read(data.join("store.opaque-wal")).unwrap();
    let locator =
        crate::plugin::retained_data::discover(&profile.path().join("plugins"), "hello", 4)
            .unwrap();
    crate::plugin::retained_data::save(&profile.path().join("plugins"), &locator).unwrap();
    write(&data.join("new/unknown.blob"), b"not in the old locator");
    let staging = tempfile::tempdir().unwrap();
    let snapshot = offline::stage(
        &profile,
        "hello",
        None,
        staging.path(),
        &SnapshotContext::default(),
    )
    .unwrap();
    assert_eq!(snapshot.schema, 4);
    assert_eq!(snapshot.files.len(), 2);
    assert!(
        snapshot
            .inventory
            .iter()
            .any(|file| file.path == "store.opaque" && file.kind == PluginDataFileKind::Sqlite)
    );
    assert!(
        snapshot
            .inventory
            .iter()
            .any(|file| file.path == "new/unknown.blob")
    );
    assert!(
        !snapshot
            .inventory
            .iter()
            .any(|file| file.path.ends_with("-wal") || file.path.ends_with("-shm"))
    );
    let staged = &snapshot
        .files
        .iter()
        .find(|file| file.archive_path.ends_with("/store.opaque"))
        .unwrap()
        .disk_path;
    let backup = Connection::open(staged).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT value FROM marker", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "committed WAL"
    );
    assert_eq!(fs::read(&database).unwrap(), database_before);
    assert_eq!(fs::read(data.join("store.opaque-wal")).unwrap(), wal_before);
    assert!(!data.join("versions").exists());
}

#[test]
fn known_sqlite_cannot_be_backed_up_as_an_opaque_file_after_corruption() {
    for damaged in [
        b"damaged header".as_slice(),
        b"SQLite format 3\0damaged pages",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let profile = ProfileRoot::prepare(dir.path()).unwrap();
        let plugins = profile.path().join("plugins");
        let database = plugins.join("hello/data/store.opaque");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE marker(value);")
            .unwrap();
        drop(connection);
        let locator = crate::plugin::retained_data::discover(&plugins, "hello", 3).unwrap();
        crate::plugin::retained_data::save(&plugins, &locator).unwrap();
        fs::write(&database, damaged).unwrap();
        let staging = tempfile::tempdir().unwrap();
        assert!(
            offline::stage(
                &profile,
                "hello",
                None,
                staging.path(),
                &SnapshotContext::default()
            )
            .is_err()
        );
        assert_eq!(fs::read(&database).unwrap(), damaged);
        assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
        let after = crate::plugin::retained_data::load(&plugins, "hello")
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(after).unwrap(),
            serde_json::to_value(locator).unwrap()
        );
    }
}

#[test]
fn missing_locator_is_conservative_but_owner_lock_and_cancellation_are_not_skips() {
    let dir = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(dir.path()).unwrap();
    let data = root.path().join("plugins/hello/data/blob");
    write(&data, b"retained");
    let staging = tempfile::tempdir().unwrap();
    let owner = PluginSlug::parse("hello").unwrap();
    let lease = PluginDataLease::try_acquire(&root, &owner).unwrap();
    assert!(
        offline::stage(
            &root,
            "hello",
            None,
            staging.path(),
            &SnapshotContext::default()
        )
        .err()
        .unwrap()
        .contains("in use")
    );
    drop(lease);
    let cancelled = SnapshotContext::default();
    cancelled.cancel.cancel();
    assert_eq!(
        offline::stage(&root, "hello", None, staging.path(), &cancelled)
            .err()
            .unwrap(),
        "BACKUP_CANCELLED"
    );
    assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
    let result = offline::stage(
        &root,
        "hello",
        None,
        staging.path(),
        &SnapshotContext::default(),
    )
    .unwrap();
    assert_eq!(fs::read(&result.files[0].disk_path).unwrap(), b"retained");
    assert_eq!(fs::read(data).unwrap(), b"retained");
}

#[cfg(unix)]
#[test]
fn linked_data_and_fifo_are_rejected_before_snapshot() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(dir.path()).unwrap();
    let data = root.path().join("plugins/hello/data");
    fs::create_dir_all(&data).unwrap();
    let outside = root.path().join("vault.db");
    write(&outside, b"core secret");
    symlink(&outside, data.join("linked")).unwrap();
    let staging = tempfile::tempdir().unwrap();
    assert!(
        offline::stage(
            &root,
            "hello",
            None,
            staging.path(),
            &SnapshotContext::default()
        )
        .is_err()
    );
    fs::remove_file(data.join("linked")).unwrap();
    let fifo = std::ffi::CString::new(data.join("pipe").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(
        offline::stage(
            &root,
            "hello",
            None,
            staging.path(),
            &SnapshotContext::default()
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
    assert_eq!(fs::read(outside).unwrap(), b"core secret");
}
