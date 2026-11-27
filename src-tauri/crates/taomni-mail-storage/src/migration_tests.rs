use super::*;
use std::time::Duration;

use crate::{
    MailFolder,
    cache::{get_cached_body, init_mail_tables, upsert_folder, upsert_message},
    parse_body_message, storage,
};

const ACCOUNT: &str = "mail-id";
const ORIGINAL: &[u8] = b"Subject: A saved message\r\n\r\nRetained during upgrade\r\n";

fn mailbox(root: &Path, account: &str) -> LegacyMailbox {
    LegacyMailbox {
        account_id: account.to_owned(),
        database: root.join(format!("{}.db", mail_db_file_stem(account))),
        pop3: false,
        preserve_in_place: false,
    }
}

fn control() -> SnapshotControl {
    SnapshotControl::with_timeout(Duration::from_secs(30))
}

#[test]
fn captures_wal_and_originals_from_custom_storage_without_changing_the_source() {
    let legacy = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let default_root = legacy.path().join("mail-cache");
    let custom_root = legacy.path().join("custom");
    fs::create_dir(&custom_root).unwrap();
    let mailbox = mailbox(&custom_root, ACCOUNT);
    let db = Connection::open(&mailbox.database).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    init_mail_tables(&db).unwrap();
    upsert_folder(
        &db,
        &MailFolder {
            account_id: ACCOUNT.into(),
            name: "INBOX".into(),
            uid_validity: Some(1),
            ..MailFolder::default()
        },
    )
    .unwrap();
    upsert_message(
        &db,
        &parse_body_message(ACCOUNT, "INBOX", 3, None, ORIGINAL, 2048),
    )
    .unwrap();
    let message = storage::store(&db, ACCOUNT, "INBOX", 3, 1, ORIGINAL).unwrap();
    let stem = mail_db_file_stem(ACCOUNT);
    let attachments = PathBuf::from("attachments").join(&stem).join("INBOX");
    fs::create_dir_all(custom_root.join(&attachments)).unwrap();
    let attachment = attachments.join("3-1.bin");
    fs::write(custom_root.join(&attachment), b"attachment").unwrap();
    fs::write(
        custom_root.join(attachments.join("3-2.part")),
        b"incomplete",
    )
    .unwrap();
    let legacy_main = mailbox.database.clone();
    let wal = custom_root.join(format!("{stem}.db-wal"));
    let source_bytes = fs::read(&legacy_main).unwrap();
    let wal_bytes = fs::read(&wal).unwrap();
    assert!(!wal_bytes.is_empty());

    let unused = LegacyMailbox {
        account_id: "unused".into(),
        database: default_root.join(format!("{}.db", mail_db_file_stem("unused"))),
        pop3: false,
        preserve_in_place: false,
    };
    let staged = StagedMailData::prepare(
        staging.path(),
        &[mailbox, unused],
        super::HostedMailboxData::ALL,
        &control(),
    )
    .unwrap();
    assert_eq!(staged.mailbox_count(), 2);
    let target = staged.data();
    assert!(
        crate::imap_ownership::database(&target, "unused")
            .unwrap()
            .is_some()
    );
    let dest = Connection::open_with_flags(
        target.join(format!("{stem}.db")),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let body = get_cached_body(&dest, ACCOUNT, "INBOX", 3)
        .unwrap()
        .unwrap();
    assert!(body.text.unwrap().contains("Retained during upgrade"));
    let object = object_path(Path::new(&format!("{stem}.mail")), &message.hash).unwrap();
    assert_eq!(
        fs::read(target.join(&object)).unwrap(),
        fs::read(custom_root.join(&object)).unwrap()
    );
    assert_eq!(fs::read(target.join(&attachment)).unwrap(), b"attachment");
    assert!(!target.join(attachments.join("3-2.part")).exists());
    assert!(!target.join(format!("{stem}.db-wal")).exists());
    assert_eq!(fs::read(&legacy_main).unwrap(), source_bytes);
    assert_eq!(fs::read(wal).unwrap(), wal_bytes);
    assert!(!default_root.exists());

    fs::write(target.join(attachment.clone()), b"new module bytes").unwrap();
    assert_eq!(
        fs::read(custom_root.join(attachment)).unwrap(),
        b"attachment"
    );
    drop(dest);
    drop(staged);
    assert_eq!(staging.path().read_dir().unwrap().count(), 0);
}

#[test]
fn a_replaced_archive_original_cannot_be_published_and_the_upgrade_can_retry() {
    let legacy = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let mailbox = mailbox(legacy.path(), ACCOUNT);
    let db = Connection::open(&mailbox.database).unwrap();
    init_mail_tables(&db).unwrap();
    let entry = storage::store(&db, ACCOUNT, "INBOX", 3, 1, ORIGINAL).unwrap();
    let path = object_path(&storage::account_root(&db, ACCOUNT).unwrap(), &entry.hash).unwrap();
    drop(db);
    let original_object = fs::read(&path).unwrap();
    let source_database = fs::read(&mailbox.database).unwrap();
    let mut mismatched_object = Vec::new();
    crate::archive::compress_message(
        &vec![b'x'; ORIGINAL.len()][..],
        &mut mismatched_object,
        || Ok(()),
    )
    .unwrap();
    fs::write(&path, &mismatched_object).unwrap();

    let prepare = || {
        StagedMailData::prepare(
            staging.path(),
            std::slice::from_ref(&mailbox),
            HostedMailboxData::ALL,
            &control(),
        )
    };
    let error = prepare().err().expect("a different original must fail");
    assert!(error.contains("checksum verification failed"), "{error}");
    assert_eq!(staging.path().read_dir().unwrap().count(), 0);
    assert_eq!(fs::read(&mailbox.database).unwrap(), source_database);
    assert_eq!(fs::read(&path).unwrap(), mismatched_object);

    fs::write(&path, &original_object).unwrap();
    let staged = prepare().unwrap();
    assert_eq!(staged.mailbox_count(), 1);
    let original_path = path.canonicalize().unwrap();
    let legacy_root = legacy.path().canonicalize().unwrap();
    let relative = original_path.strip_prefix(&legacy_root).unwrap();
    assert_eq!(
        fs::read(staged.data().join(relative)).unwrap(),
        original_object
    );
}

#[test]
fn follows_a_relocated_mailbox_and_rejects_a_missing_relocation_target() {
    let legacy = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let from = mailbox(legacy.path(), ACCOUNT);
    let to = mailbox(&custom.path().canonicalize().unwrap(), ACCOUNT);
    {
        let db = Connection::open(&to.database).unwrap();
        init_mail_tables(&db).unwrap();
    }
    crate::database::write_redirect(&from.database, &to.database).unwrap();
    let staged = StagedMailData::prepare(
        staging.path(),
        &[from],
        super::HostedMailboxData::ALL,
        &control(),
    )
    .unwrap();
    assert_eq!(staged.mailbox_count(), 1);
    drop(staged);

    fs::remove_file(&to.database).unwrap();
    let from = mailbox(legacy.path(), ACCOUNT);
    let error = StagedMailData::prepare(
        staging.path(),
        &[from],
        super::HostedMailboxData::ALL,
        &control(),
    )
    .err()
    .unwrap();
    assert!(error.contains("relocation target is missing"), "{error}");
    assert_eq!(staging.path().read_dir().unwrap().count(), 0);
}

#[test]
fn bad_second_account_discards_the_first_snapshot_and_can_be_retried() {
    let legacy = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let valid = mailbox(legacy.path(), ACCOUNT);
    let broken = mailbox(legacy.path(), "broken");
    {
        let db = Connection::open(&valid.database).unwrap();
        init_mail_tables(&db).unwrap();
    }
    fs::write(&broken.database, b"not sqlite").unwrap();
    let mailboxes = [valid, broken];
    assert!(
        StagedMailData::prepare(
            staging.path(),
            &mailboxes,
            super::HostedMailboxData::ALL,
            &control()
        )
        .is_err()
    );
    assert_eq!(staging.path().read_dir().unwrap().count(), 0);
    assert_eq!(fs::read(&mailboxes[1].database).unwrap(), b"not sqlite");
    assert!(
        StagedMailData::prepare(
            staging.path(),
            &mailboxes,
            super::HostedMailboxData::ALL,
            &SnapshotControl::with_timeout(Duration::ZERO)
        )
        .is_err()
    );
    assert_eq!(staging.path().read_dir().unwrap().count(), 0);
    fs::remove_file(&mailboxes[1].database).unwrap();
    assert_eq!(
        StagedMailData::prepare(
            staging.path(),
            &mailboxes,
            super::HostedMailboxData::ALL,
            &control()
        )
        .unwrap()
        .mailbox_count(),
        2
    );
    assert!(!mailboxes[1].database.exists());
}

#[cfg(unix)]
#[test]
fn rejects_a_linked_wal_before_opening_sqlite() {
    let legacy = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let mailbox = mailbox(legacy.path(), ACCOUNT);
    {
        let db = Connection::open(&mailbox.database).unwrap();
        init_mail_tables(&db).unwrap();
    }
    let other = legacy.path().join("outside-wal");
    fs::write(&other, b"outside").unwrap();
    let mut wal = mailbox.database.as_os_str().to_owned();
    wal.push("-wal");
    std::os::unix::fs::symlink(&other, wal).unwrap();
    let error = StagedMailData::prepare(
        staging.path(),
        &[mailbox],
        super::HostedMailboxData::ALL,
        &control(),
    )
    .err()
    .unwrap();
    assert!(error.contains("symbolic link"), "{error}");
    assert_eq!(fs::read(other).unwrap(), b"outside");
    assert_eq!(staging.path().read_dir().unwrap().count(), 0);
}

#[test]
fn detects_preexisting_drafts_in_the_last_relocated_cache_without_initializing_storage() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let filename = format!("{}.db", crate::database::mail_db_file_stem("qa"));
    let old = root.join("missing").join(&filename);
    assert!(
        super::read_legacy_mailbox(&old, "qa", crate::draft_import::read_account)
            .unwrap()
            .is_none()
    );
    assert!(!root.join("missing").exists());
    std::fs::create_dir(root.join("missing")).unwrap();
    let current = root.join(&filename);
    crate::database::write_redirect(&old, &current).unwrap();
    assert!(super::read_legacy_mailbox(&old, "qa", crate::draft_import::read_account).is_err());
    let db = rusqlite::Connection::open(&current).unwrap();
    crate::cache::init_mail_tables(&db).unwrap();
    let queued = |id| {
        serde_json::from_value(serde_json::json!({"id":id, "subject":"Queued before upgrade"}))
            .unwrap()
    };
    crate::drafts::save_mail_draft(&db, "other", queued("other-draft")).unwrap();
    assert!(
        super::read_legacy_mailbox(&old, "qa", crate::draft_import::read_account)
            .unwrap()
            .unwrap()
            .is_empty()
    );
    crate::drafts::save_mail_draft(&db, "qa", queued("waiting")).unwrap();
    drop(db);
    let before = std::fs::read(&current).unwrap();
    assert_eq!(
        super::read_legacy_mailbox(&old, "qa", crate::draft_import::read_account)
            .unwrap()
            .unwrap()
            .len(),
        1
    );
    assert!(
        super::read_legacy_mailbox(&old, "other", crate::draft_import::read_account)
            .unwrap_err()
            .contains("relocation target")
    );
    assert_eq!(before, std::fs::read(&current).unwrap());
    assert!(!old.exists());
}

#[test]
fn only_staging_for_a_host_that_takes_draft_ownership_marks_the_mailbox() {
    let legacy = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let source = mailbox(legacy.path(), ACCOUNT);
    {
        let db = Connection::open(&source.database).unwrap();
        init_mail_tables(&db).unwrap();
        let draft = serde_json::from_value(serde_json::json!({
            "id": "scheduled", "subject": "Before the split",
            "replyContext": {"outbox": {"sendAt": 4102444800_i64}}
        }))
        .unwrap();
        crate::drafts::save_mail_draft(&db, ACCOUNT, draft).unwrap();
    }
    let original = fs::read(&source.database).unwrap();
    for hosted in [
        super::HostedMailboxData::default(),
        super::HostedMailboxData {
            drafts: true,
            ..Default::default()
        },
        super::HostedMailboxData::ALL,
    ] {
        let copy = StagedMailData::prepare(
            staging.path(),
            std::slice::from_ref(&source),
            hosted,
            &control(),
        )
        .unwrap();
        let db = Connection::open(copy.data().join(source.database.file_name().unwrap())).unwrap();
        assert_eq!(
            crate::draft_import::is_owned(&db, ACCOUNT).unwrap(),
            hosted.drafts
        );
        assert_eq!(
            crate::contacts::handoff::is_owned(&db, ACCOUNT).unwrap(),
            hosted.address_book
        );
        assert_eq!(
            crate::filters::rules::is_owned(&db, ACCOUNT).unwrap(),
            hosted.filter_rules
        );
        let draft = crate::drafts::get_mail_draft(&db, ACCOUNT, "scheduled")
            .unwrap()
            .unwrap();
        assert_eq!(
            draft.reply_context.unwrap().outbox.unwrap().send_at,
            Some(4102444800)
        );
    }
    assert_eq!(fs::read(&source.database).unwrap(), original);
}

#[test]
fn imap_owner_receipt_selects_complete_module_data_and_survives_missing_legacy_cache() {
    let legacy = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let mailbox = mailbox(legacy.path(), ACCOUNT);
    let stage = StagedMailData::prepare(
        staging.path(),
        &[mailbox],
        HostedMailboxData::ALL,
        &control(),
    )
    .unwrap();
    let directory = stage.data();
    let database = crate::imap_ownership::database(&directory, ACCOUNT)
        .unwrap()
        .unwrap();
    assert!(!legacy.path().join(database.file_name().unwrap()).exists());
    let handle = crate::database::MailDatabase::new_owned(database.clone());
    let db = handle.lock().unwrap();
    let messages = crate::cache::list_cached_messages(&db, ACCOUNT, "INBOX", 10, 0).unwrap();
    assert!(messages.is_empty());
    drop(db);

    let elsewhere = legacy.path().join(database.file_name().unwrap());
    crate::database::write_redirect(&database, &elsewhere).unwrap();
    assert!(crate::imap_ownership::database(&directory, ACCOUNT).is_err());
    assert!(handle.lock().is_err());
    assert!(!elsewhere.exists());
}

#[test]
fn preserves_custom_storage_mailbox_in_place_without_copying_archives() {
    let custom = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let custom_root = custom.path().canonicalize().unwrap();
    let mut custom_mailbox = mailbox(&custom_root, ACCOUNT);
    custom_mailbox.preserve_in_place = true;
    let db = Connection::open(&custom_mailbox.database).unwrap();
    init_mail_tables(&db).unwrap();
    upsert_message(
        &db,
        &parse_body_message(ACCOUNT, "INBOX", 3, None, ORIGINAL, 2048),
    )
    .unwrap();
    let stored = storage::store(&db, ACCOUNT, "INBOX", 3, 1, ORIGINAL).unwrap();
    drop(db);
    let stem = mail_db_file_stem(ACCOUNT);
    let attachments = PathBuf::from("attachments").join(&stem).join("INBOX");
    fs::create_dir_all(custom_root.join(&attachments)).unwrap();
    fs::write(custom_root.join(attachments.join("3-1.bin")), b"attachment").unwrap();
    let db_before = fs::read(&custom_mailbox.database).unwrap();
    let object = object_path(
        &custom_root.join(format!("{stem}.mail")),
        &stored.hash,
    )
    .unwrap();
    let object_before = fs::read(&object).unwrap();

    let staged = StagedMailData::prepare(
        staging.path(),
        &[custom_mailbox],
        HostedMailboxData::ALL,
        &control(),
    )
    .unwrap();
    assert_eq!(staged.mailbox_count(), 0);
    assert_eq!(staged.data().read_dir().unwrap().count(), 0);
    assert!(
        crate::imap_ownership::database(&staged.data(), ACCOUNT)
            .unwrap()
            .is_none()
    );
    assert_eq!(fs::read(custom_root.join(format!("{stem}.db"))).unwrap(), db_before);
    assert_eq!(fs::read(&object).unwrap(), object_before);

    let broken_name = format!("{}.db", mail_db_file_stem("broken-link"));
    let missing_target = custom_root.join(&broken_name);
    let elsewhere = custom_root.join("missing-dir").join(&broken_name);
    crate::database::write_redirect(&missing_target, &elsewhere).unwrap();
    let broken_redirect = LegacyMailbox {
        account_id: "broken-link".into(),
        database: missing_target,
        pop3: false,
        preserve_in_place: true,
    };
    let error = StagedMailData::prepare(
        staging.path(),
        &[broken_redirect],
        HostedMailboxData::ALL,
        &control(),
    )
    .err()
    .unwrap();
    assert!(error.contains("relocation target is missing"), "{error}");
}
