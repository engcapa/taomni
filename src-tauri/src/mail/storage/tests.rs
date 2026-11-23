use super::relocation::{configured_directory, relocate};
use super::{FullMessageMode, account_root, read, store, stores_full};
use rusqlite::Connection;
use std::fs;
use std::path::Path;
use taomni_mail_engine::database::{MAIL_MUTATION_LOCK, ProcessLock};

#[test]
fn relocation_switches_the_existing_connection_and_rolls_back_publication_failure() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let stem = crate::state::mail_db_file_stem("qa");
    let source_path = source.path().join(format!("{stem}.db"));
    let mut db = Connection::open(&source_path).unwrap();
    super::super::init_mail_tables(&db).unwrap();
    let raw = b"Subject: moving\r\n\r\noriginal";
    store(&db, "qa", "INBOX", 1, 10, raw.as_slice()).unwrap();
    let partial = account_root(&db, "qa").unwrap().join("partial/qa.part");
    fs::create_dir_all(partial.parent().unwrap()).unwrap();
    fs::write(&partial, b"resumable bytes").unwrap();
    let attachment =
        super::super::parts::attachment_cache_path(source.path(), &stem, "INBOX", 1, "2");
    fs::create_dir_all(attachment.parent().unwrap()).unwrap();
    fs::write(&attachment, b"cached attachment").unwrap();
    let mutation = ProcessLock::try_at(&source_path, MAIL_MUTATION_LOCK)
        .unwrap()
        .unwrap();
    let blocked = relocate(&mut db, "qa", target.path(), || {
        panic!("settings must stay unchanged while the account lease is held");
    })
    .unwrap_err();
    assert!(
        blocked.contains("Mail operations are in progress"),
        "{blocked}"
    );
    assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
    assert!(!target.path().join(format!("{stem}.db")).exists());
    drop(mutation);
    assert!(
        relocate(&mut db, "qa", target.path(), || Err(
            "settings save failed".into()
        ))
        .is_err()
    );
    assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
    assert!(source_path.exists());
    assert!(!target.path().join(format!("{stem}.db")).exists());
    relocate(&mut db, "qa", target.path(), || Ok(())).unwrap();
    assert!(!source_path.exists());
    assert_eq!(
        fs::read(account_root(&db, "qa").unwrap().join("partial/qa.part")).unwrap(),
        b"resumable bytes"
    );
    assert_eq!(
        fs::read(super::super::parts::attachment_cache_path(
            target.path(),
            &stem,
            "INBOX",
            1,
            "2"
        ))
        .unwrap(),
        b"cached attachment"
    );
    assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
    assert_eq!(
        Path::new(db.path().unwrap()).parent().unwrap(),
        target.path().canonicalize().unwrap()
    );
    let collision = source.path().join(format!("{stem}.db"));
    fs::write(&collision, b"existing unrelated file").unwrap();
    assert!(relocate(&mut db, "qa", source.path(), || Ok(())).is_err());
    assert_eq!(fs::read(collision).unwrap(), b"existing unrelated file");
}

#[test]
fn folder_selection_keeps_exact_names_and_inbox_case_rules() {
    let mut settings = super::super::MailCacheSettings::default();
    assert!(stores_full(&settings, "Archive"));
    settings.full_message_mode = FullMessageMode::Include;
    settings.full_message_folders = vec!["inbox".into(), "Projects/A".into()];
    assert!(stores_full(&settings, "INBOX"));
    assert!(stores_full(&settings, "Projects/A"));
    assert!(!stores_full(&settings, "projects/a"));
    settings.full_message_mode = FullMessageMode::Exclude;
    assert!(!stores_full(&settings, "INBOX"));
    assert!(stores_full(&settings, "Sent"));
    assert!(
        configured_directory(
            r#"{"mailStorageDirectory":"relative"}"#,
            directory_default()
        )
        .is_err()
    );
}

#[test]
fn readable_folder_selection_matches_imap_keys_for_include_and_exclude() {
    for (selection, folder, selected) in [
        ("台北", "&U,BTFw-", true),
        ("&U,BTFw-", "&U,BTFw-", true),
        ("  台北  ", "&U,BTFw-", true),
        ("Projects/台北", "Projects/&U,BTFw-", true),
        ("台北", "Projects/&U,BTFw-", false),
        ("projects/台北", "Projects/&U,BTFw-", false),
        ("A & B", "A &- B", true),
        ("中文", "中文", true),
        ("inbox", "INBOX", true),
        ("archive", "Archive", false),
        ("Other", "&U,BTFw-", false),
    ] {
        let mut settings = super::super::MailCacheSettings {
            full_message_mode: FullMessageMode::Include,
            full_message_folders: vec![selection.into()],
            ..Default::default()
        };
        assert_eq!(
            stores_full(&settings, folder),
            selected,
            "include {selection} / {folder}"
        );
        settings.full_message_mode = FullMessageMode::Exclude;
        assert_eq!(
            stores_full(&settings, folder),
            !selected,
            "exclude {selection} / {folder}"
        );
    }
}

fn directory_default() -> &'static Path {
    Path::new("/unused-test-default")
}
