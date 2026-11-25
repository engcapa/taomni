use super::{live::validate_and_copy, test_support::write};
use crate::{
    backup::snapshot_context::SnapshotContext,
    plugin::retained_data::{DataFileKind, RetainedDataFile},
};
use std::{fs, path::Path};
use taomni_plugin_api::services::{SafeRelativePath, Sha256Digest, SnapshotFile};

fn metadata(root: &Path, relative: &str) -> SnapshotFile {
    SnapshotFile {
        relative_path: SafeRelativePath::parse(relative).unwrap(),
        size_bytes: fs::metadata(root.join(relative)).unwrap().len(),
        sha256: Sha256Digest::parse(
            SnapshotContext::default()
                .hash(&root.join(relative))
                .unwrap(),
        )
        .unwrap(),
    }
}

fn expected(path: &str, kind: DataFileKind) -> Vec<RetainedDataFile> {
    vec![RetainedDataFile {
        path: path.into(),
        kind,
    }]
}

#[test]
fn the_verified_copy_is_private_and_does_not_follow_a_replaced_export() {
    let export = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(export.path()).unwrap();
    write(&root.join("nested/opaque"), b"original\0bytes");
    let staged = tempfile::tempdir().unwrap();
    let input = expected("nested/opaque", DataFileKind::File);
    let snapshot = validate_and_copy(
        &root,
        staged.path(),
        "hello-plugin",
        7,
        &input,
        &[metadata(&root, "nested/opaque")],
        &SnapshotContext::default(),
    )
    .unwrap();
    fs::write(root.join("nested/opaque"), b"changed after verification").unwrap();
    assert_eq!(
        fs::read(&snapshot.files[0].disk_path).unwrap(),
        b"original\0bytes"
    );
    assert_eq!(
        snapshot.files[0].archive_path,
        "plugins/hello-plugin/data/nested/opaque"
    );
    assert_eq!(snapshot.schema, 7);
}

#[test]
fn changed_hash_size_missing_and_ungranted_files_never_publish_private_staging() {
    let export = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(export.path()).unwrap();
    write(&root.join("data"), b"original");
    let valid = metadata(&root, "data");
    let mut wrong_hash = valid.clone();
    wrong_hash.sha256 = Sha256Digest::parse("a".repeat(64)).unwrap();
    let mut wrong_size = valid.clone();
    wrong_size.size_bytes += 1;
    let mut other = valid.clone();
    other.relative_path = SafeRelativePath::parse("ungranted").unwrap();
    for files in [
        vec![wrong_hash],
        vec![wrong_size],
        vec![other],
        Vec::new(),
        vec![valid.clone(), valid.clone()],
    ] {
        let staged = tempfile::tempdir().unwrap();
        assert!(
            validate_and_copy(
                &root,
                staged.path(),
                "hello-plugin",
                1,
                &expected("data", DataFileKind::File),
                &files,
                &SnapshotContext::default()
            )
            .is_err()
        );
        assert_eq!(fs::read_dir(staged.path()).unwrap().count(), 0);
        assert_eq!(fs::read(root.join("data")).unwrap(), b"original");
    }
}

#[test]
fn real_standalone_sqlite_passes_and_type_confusion_corruption_and_cancellation_fail() {
    let export = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(export.path()).unwrap();
    let db = rusqlite::Connection::open(root.join("data")).unwrap();
    db.execute_batch("CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('retained committed value');").unwrap();
    drop(db);
    let staged = tempfile::tempdir().unwrap();
    let files = [metadata(&root, "data")];
    let snapshot = validate_and_copy(
        &root,
        staged.path(),
        "hello-plugin",
        1,
        &expected("data", DataFileKind::Sqlite),
        &files,
        &SnapshotContext::default(),
    )
    .unwrap();
    let db = rusqlite::Connection::open(&snapshot.files[0].disk_path).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM records", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "retained committed value"
    );
    drop(db);
    assert!(
        validate_and_copy(
            &root,
            staged.path(),
            "hello-plugin",
            1,
            &expected("data", DataFileKind::File),
            &files,
            &SnapshotContext::default()
        )
        .is_err()
    );
    let context = SnapshotContext::default();
    context.cancel.cancel();
    assert!(
        validate_and_copy(
            &root,
            staged.path(),
            "hello-plugin",
            1,
            &expected("data", DataFileKind::Sqlite),
            &files,
            &context
        )
        .is_err()
    );
    fs::write(root.join("data"), b"SQLite format 3\0corrupt bytes").unwrap();
    assert!(
        validate_and_copy(
            &root,
            staged.path(),
            "hello-plugin",
            1,
            &expected("data", DataFileKind::Sqlite),
            &[metadata(&root, "data")],
            &SnapshotContext::default()
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn export_directory_and_file_links_are_rejected_through_pinned_handles() {
    use std::os::unix::fs::symlink;
    let export = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(export.path()).unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(&outside.path().join("data"), b"external data");
    symlink(outside.path(), root.join("nested")).unwrap();
    symlink(outside.path().join("data"), root.join("linked-file")).unwrap();
    assert!(super::open_snapshot::open(&root, "nested/data").is_err());
    assert!(super::open_snapshot::open(&root, "linked-file").is_err());
    let original = root.join("original");
    write(&original, b"pinned bytes");
    let mut handle = super::open_snapshot::open(&root, "original").unwrap();
    fs::rename(&original, root.join("renamed")).unwrap();
    symlink(outside.path().join("data"), &original).unwrap();
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut handle, &mut bytes).unwrap();
    assert_eq!(bytes, b"pinned bytes");
}
