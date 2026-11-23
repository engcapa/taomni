use std::{cell::Cell, fs};

use taomni_mail_engine::{MailFolder, cache::upsert_folder};
use taomni_plugin_api::ErrorCode;

use super::*;

#[test]
fn first_initialization_is_idempotent_and_protects_existing_legacy_data() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(profile.path());
    assert!(initialize(&store, "new", &|| Ok(())).unwrap());
    let path = profile.path().join("plugins/mail/data");
    let new = imap_ownership::database(&path, "new").unwrap().unwrap();
    let db = Connection::open(&new).unwrap();
    upsert_folder(
        &db,
        &MailFolder {
            account_id: "new".into(),
            name: "INBOX".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(initialize(&store, "new", &|| Ok(())).unwrap());
    assert_eq!(
        taomni_mail_engine::cache::list_cached_folders(&db, "new")
            .unwrap()
            .len(),
        1
    );

    let stale = database_for(&path, "stale");
    store.mutate("stale", true, &|| Ok(()), |_| Ok(())).unwrap();
    let original = fs::read(&stale).unwrap();
    assert!(!initialize(&store, "stale", &|| Ok(())).unwrap());
    assert_eq!(fs::read(stale).unwrap(), original);

    let root = path.join("attachments").join(mail_db_file_stem("restored"));
    fs::create_dir_all(root).unwrap();
    assert!(!initialize(&store, "restored", &|| Ok(())).unwrap());
    assert!(
        imap_ownership::database(&path, "restored")
            .unwrap()
            .is_none()
    );
}

#[test]
fn retry_completes_an_account_interrupted_before_receipt_publication() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(profile.path());
    let checks = Cell::new(0);
    let result = initialize(&store, "retry", &|| {
        checks.set(checks.get() + 1);
        if checks.get() == 6 {
            Err(RpcError::from_code(ErrorCode::RequestCancelled))
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    let path = profile.path().join("plugins/mail/data");
    assert!(database_for(&path, "retry").exists());
    assert!(imap_ownership::database(&path, "retry").unwrap().is_none());
    assert!(initialize(&store, "retry", &|| Ok(())).unwrap());
    assert!(imap_ownership::database(&path, "retry").unwrap().is_some());
}

#[test]
fn concurrent_requests_publish_one_empty_mailbox() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::new(profile.path());
    std::thread::scope(|scope| {
        let first = scope.spawn(|| initialize(&store, "concurrent", &|| Ok(())).unwrap());
        let second = scope.spawn(|| initialize(&store, "concurrent", &|| Ok(())).unwrap());
        assert!(first.join().unwrap());
        assert!(second.join().unwrap());
    });
    let data = profile.path().join("plugins/mail/data");
    assert!(
        imap_ownership::database(&data, "concurrent")
            .unwrap()
            .is_some()
    );
    assert_eq!(fs::read_dir(data).unwrap().count(), 2);
}
