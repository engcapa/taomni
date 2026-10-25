use super::{
    archive_writer::{StagedFile, pack_staged_archive_with_provenance},
    provider::TransferContext,
    snapshot_context::SnapshotContext,
};
use std::{io::Read, sync::Arc};

fn cancelling_at(phase: &'static str) -> SnapshotContext {
    let cancel = tokio_util::sync::CancellationToken::new();
    let signal = cancel.clone();
    SnapshotContext::new(Some(TransferContext {
        cancel,
        report: Arc::new(move |current, _, _| {
            if current == phase {
                signal.cancel();
            }
        }),
    }))
}

#[test]
fn cancelling_packing_or_encryption_preserves_the_previous_artifact_and_cleans_temps() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.db");
    std::fs::write(&source, vec![7u8; 1024 * 1024]).unwrap();
    let output = dir.path().join("archive.taobak");
    for phase in ["packing", "encrypting"] {
        std::fs::write(&output, b"previous working archive").unwrap();
        let files = [StagedFile {
            archive_path: "databases/taomni.db".into(),
            disk_path: source.clone(),
        }];
        let error = pack_staged_archive_with_provenance(
            &files,
            "1",
            "core",
            Some("password"),
            &output,
            None,
            &cancelling_at(phase),
        )
        .unwrap_err();
        assert!(error.contains("BACKUP_CANCELLED"), "{phase}: {error}");
        assert_eq!(std::fs::read(&output).unwrap(), b"previous working archive");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}

#[test]
fn cancellation_interrupts_a_reader_after_it_has_started() {
    let context = SnapshotContext::default();
    let mut reader = context.reader(std::io::Cursor::new(vec![3; 1024]));
    let mut buffer = [0; 32];
    assert_eq!(reader.read(&mut buffer).unwrap(), 32);
    context.cancel.cancel();
    assert!(
        reader
            .read(&mut buffer)
            .unwrap_err()
            .to_string()
            .contains("BACKUP_CANCELLED")
    );
}

#[test]
fn cancellation_interrupts_sqlite_and_releases_the_progress_handler() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    let context = SnapshotContext::default();
    let signal = context.cancel.clone();
    let worker = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(20));
        signal.cancel();
    });
    let error = context.sqlite(&db, || db.query_row("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())).unwrap_err();
    worker.join().unwrap();
    assert_eq!(error, "BACKUP_CANCELLED");
    assert_eq!(
        db.query_row("SELECT 42", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        42
    );
}

#[test]
fn cancellation_interrupts_waiting_for_an_in_process_snapshot_lock() {
    let mutex = std::sync::Mutex::new(());
    let guard = mutex.lock().unwrap();
    let context = SnapshotContext::default();
    let signal = context.cancel.clone();
    let worker = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(20));
        signal.cancel();
    });
    assert_eq!(context.lock(&mutex).unwrap_err(), "BACKUP_CANCELLED");
    worker.join().unwrap();
    drop(guard);
}

#[test]
fn cancellation_stops_copying_and_verification_of_a_valid_archive() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    std::fs::write(&source, vec![6u8; 128 * 1024]).unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    let signal = cancel.clone();
    let context = SnapshotContext::new(Some(TransferContext {
        cancel,
        report: Arc::new(move |_, bytes, _| {
            if bytes >= 64 * 1024 {
                signal.cancel();
            }
        }),
    }));
    context.begin("snapshotting", Some(64 * 1024)).unwrap();
    let target = dir.path().join("partial");
    assert!(
        context
            .copy(&source, &target)
            .unwrap_err()
            .contains("BACKUP_CANCELLED")
    );
    assert!(target.metadata().unwrap().len() < source.metadata().unwrap().len());

    let archive = dir.path().join("archive.taobak");
    super::archive_writer::pack_staged_archive(
        &[StagedFile {
            archive_path: "databases/taomni.db".into(),
            disk_path: source,
        }],
        "1",
        "custom",
        None,
        &archive,
    )
    .unwrap();
    let error =
        super::restore::inspect_archive_with_context(&archive, None, &cancelling_at("verifying"))
            .unwrap_err();
    assert!(error.contains("BACKUP_CANCELLED"), "{error}");
    assert!(super::restore::inspect_archive(&archive, None).is_ok());
}

#[test]
fn mail_subcategories_control_staged_files_and_restoreable_original_indexes() {
    use super::{
        mail_snapshot::snapshot_mail_with_options,
        range::{BackupCustomOptions, resolve_scope_flags},
    };
    let dir = tempfile::tempdir().unwrap();
    let account = "mail-categories";
    let stem = crate::state::mail_db_file_stem(account);
    let db = rusqlite::Connection::open(dir.path().join(format!("{stem}.db"))).unwrap();
    crate::mail::init_mail_tables(&db).unwrap();
    crate::mail::storage::store(
        &db,
        account,
        "INBOX",
        1,
        42,
        b"Subject: original\r\n\r\nbody".as_slice(),
    )
    .unwrap();
    let attachment_dir = dir.path().join("attachments").join(&stem).join("42");
    std::fs::create_dir_all(&attachment_dir).unwrap();
    std::fs::write(attachment_dir.join("1.bin"), b"downloaded attachment").unwrap();
    for (originals, attachments) in [(false, false), (false, true), (true, false), (true, true)] {
        let staging = tempfile::tempdir().unwrap();
        let options = BackupCustomOptions {
            include_mail: true,
            include_mail_originals: Some(originals),
            include_mail_attachments: Some(attachments),
            ..Default::default()
        };
        let files = snapshot_mail_with_options(
            &db,
            Some(account),
            staging.path(),
            resolve_scope_flags("custom", Some(options)),
            &SnapshotContext::default(),
        )
        .unwrap();
        assert_eq!(
            files.iter().any(|f| f.archive_path.ends_with(".eml.gz")),
            originals
        );
        assert_eq!(
            files.iter().any(|f| f.archive_path.ends_with(".bin")),
            attachments
        );
        let snapshot = rusqlite::Connection::open(&files[0].disk_path).unwrap();
        let count: i64 = snapshot
            .query_row("SELECT count(*) FROM mail_full_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, i64::from(originals));
        let archive = staging.path().join("selection.taobak");
        super::archive_writer::pack_staged_archive(&files, "1", "custom", None, &archive).unwrap();
        assert_eq!(
            super::restore::inspect_archive(&archive, None)
                .unwrap()
                .files
                .len(),
            files.len()
        );
    }
    assert_eq!(
        db.query_row("SELECT count(*) FROM mail_full_messages", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn opening_a_mail_snapshot_does_not_run_schema_or_original_index_migrations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy-mail.db");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy');",
        )
        .unwrap();
    let handle = crate::mail::coordination::MailDatabase::new(path);
    {
        let guard = handle
            .lock_for_snapshot(&tokio_util::sync::CancellationToken::new())
            .unwrap();
        assert_eq!(
            guard
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name LIKE 'mail_%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(
            super::mail_snapshot::snapshot_account(&guard)
                .unwrap()
                .is_none()
        );
    }
    // A later normal mailbox access still performs the deferred initialization.
    let guard = handle.lock().unwrap();
    assert_eq!(
        guard
            .query_row("SELECT value FROM retained", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "legacy"
    );
    assert!(
        guard
            .prepare("SELECT account_id FROM mail_messages")
            .is_ok()
    );
}
