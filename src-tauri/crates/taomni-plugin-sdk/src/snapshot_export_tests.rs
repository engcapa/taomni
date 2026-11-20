use super::{test_support::*, *};
use std::fs;

#[test]
fn a_sqlite_handle_cannot_be_exported_through_the_ordinary_file_path() {
    let fixture = Fixture::new();
    let source = fixture.root.path().join("plugins/mfa/data/mfa.db");
    let mut output = SnapshotExport::new(&fixture.request.destination, operation());
    let error = output
        .file("mfa.db", fs::File::open(&source).unwrap())
        .unwrap_err();
    assert_eq!(error.message, "PLUGIN_SQLITE_SNAPSHOT_REQUIRED");
    assert!(
        !fixture
            .request
            .destination
            .absolute_job_root
            .join("mfa.db")
            .exists()
    );
}

#[test]
fn an_opaque_attachment_grant_preserves_sqlite_payload_bytes() {
    let fixture = Fixture::new();
    let source = fixture.root.path().join("plugins/mfa/data/mfa.db");
    let mut grant = fixture.request.destination.clone();
    let attachment = SafeRelativePath::parse("attachments/mail/INBOX/4-1.bin").unwrap();
    grant.opaque_files = vec![attachment.clone()];
    assert!(SnapshotExport::validate(&grant, fixture.root.path()).is_err());
    grant.allowed_files = vec![attachment.clone()];
    SnapshotExport::validate(&grant, fixture.root.path()).unwrap();

    let mut output = SnapshotExport::new(&grant, operation());
    let db = rusqlite::Connection::open(&source).unwrap();
    assert!(output.sqlite(attachment.as_str(), &db).is_err());
    output
        .file(attachment.as_str(), fs::File::open(&source).unwrap())
        .unwrap();
    assert_eq!(
        fs::read(grant.absolute_job_root.join(attachment.as_str())).unwrap(),
        fs::read(source).unwrap(),
    );
    assert_eq!(output.complete().unwrap().len(), 1);
}

#[test]
fn a_grant_rejects_aliased_paths_nonempty_roots_and_business_data_destinations() {
    let fixture = Fixture::new();
    let profile = fixture.root.path();
    let mut grant = fixture.request.destination.clone();
    for paths in [
        vec!["same", "same/child"],
        vec!["Dir/a", "dir/b"],
        vec!["A", "a"],
    ] {
        grant.allowed_files = paths
            .into_iter()
            .map(|path| SafeRelativePath::parse(path).unwrap())
            .collect();
        assert!(SnapshotExport::validate(&grant, profile).is_err());
    }
    grant = fixture.request.destination.clone();
    fs::write(
        grant.absolute_job_root.join("already-there"),
        b"working data",
    )
    .unwrap();
    assert!(SnapshotExport::validate(&grant, profile).is_err());
    grant.absolute_job_root = profile.join("plugins/mfa/data");
    assert!(SnapshotExport::validate(&grant, profile).is_err());
}

#[test]
fn ordinary_bytes_are_copied_from_the_beginning_and_duplicate_or_ungranted_writes_fail() {
    use std::io::{Seek, SeekFrom};
    let fixture = Fixture::new();
    let source = fixture.root.path().join("input.txt");
    fs::write(&source, b"original\0bytes").unwrap();
    let mut grant = fixture.request.destination.clone();
    grant.allowed_files = vec![SafeRelativePath::parse("nested/file.txt").unwrap()];
    let mut output = SnapshotExport::new(&grant, operation());
    assert!(
        output
            .file("elsewhere", fs::File::open(&source).unwrap())
            .is_err()
    );
    let mut input = fs::File::open(&source).unwrap();
    input.seek(SeekFrom::Start(4)).unwrap();
    output.file("nested/file.txt", input).unwrap();
    assert!(
        output
            .file("nested/file.txt", fs::File::open(&source).unwrap())
            .is_err()
    );
    assert_eq!(
        fs::read(grant.absolute_job_root.join("nested/file.txt")).unwrap(),
        b"original\0bytes"
    );
    assert_eq!(output.complete().unwrap()[0].size_bytes, 14);
}

#[cfg(unix)]
#[test]
fn linked_output_directories_and_hard_linked_inputs_are_rejected() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let source = fixture.root.path().join("input");
    fs::write(&source, b"safe").unwrap();
    fs::hard_link(&source, fixture.root.path().join("alias")).unwrap();
    let mut output = SnapshotExport::new(&fixture.request.destination, operation());
    assert!(
        output
            .file("mfa.db", fs::File::open(&source).unwrap())
            .is_err()
    );
    let mut grant = fixture.request.destination.clone();
    grant.allowed_files = vec![SafeRelativePath::parse("nested/file").unwrap()];
    let elsewhere = fixture.root.path().join("outside");
    fs::create_dir(&elsewhere).unwrap();
    symlink(&elsewhere, grant.absolute_job_root.join("nested")).unwrap();
    fs::remove_file(fixture.root.path().join("alias")).unwrap();
    let mut output = SnapshotExport::new(&grant, operation());
    assert!(
        output
            .file("nested/file", fs::File::open(source).unwrap())
            .is_err()
    );
    assert_eq!(fs::read_dir(elsewhere).unwrap().count(), 0);
}
