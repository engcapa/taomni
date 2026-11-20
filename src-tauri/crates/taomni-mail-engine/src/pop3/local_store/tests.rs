use super::*;
use crate::{cache::init_mail_tables, storage};

fn raw(subject: &str) -> Vec<u8> {
    format!(
            "From: Sender <s@example.com>\r\nTo: me@example.com\r\nSubject: {subject}\r\nDate: Tue, 14 Nov 2023 22:13:20 +0000\r\nMessage-ID: <{subject}@example.com>\r\n\r\n.leading dot line\r\nbody of {subject}\r\n"
        )
        .into_bytes()
}

#[test]
fn local_folders_move_copy_delete() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    ensure_local_folders(&conn, "pop").unwrap();
    let a = insert_local(&conn, "pop", "INBOX", &raw("alpha"), &[]).unwrap();
    let b = insert_local(&conn, "pop", "INBOX", &raw("beta"), &["\\Seen"]).unwrap();
    assert_eq!((a.header.uid, b.header.uid), (1, 2));
    create_local_folder(&conn, "pop", "Projects").unwrap();
    assert_eq!(
        move_local(&conn, "pop", "INBOX", &[1], "Projects", false).unwrap(),
        1
    );
    assert_eq!(
        move_local(&conn, "pop", "INBOX", &[2], "Archive2", true).unwrap(),
        1
    );
    let folders = list_cached_folders(&conn, "pop").unwrap();
    let count = |name: &str| {
        folders
            .iter()
            .find(|f| f.name == name)
            .and_then(|f| f.total)
    };
    assert_eq!(count("INBOX"), Some(1));
    assert_eq!(count("Projects"), Some(1));
    assert!(local_raw(&conn, "pop", "Projects", 1).unwrap().is_some());
    assert_eq!(delete_local(&conn, "pop", "INBOX", Some(&[2])).unwrap(), 1);
    rename_local_folder(&conn, "pop", "Projects", "Work").unwrap();
    assert!(local_raw(&conn, "pop", "Work", 1).unwrap().is_some());
    assert!(has_local_store(&conn, "pop").unwrap());
}

#[test]
fn permanent_delete_retains_original_and_cleanup_never_reuses_its_uid() {
    let dir = tempfile::tempdir().unwrap();
    let conn = Connection::open(dir.path().join("qa-pop3.db")).unwrap();
    init_mail_tables(&conn).unwrap();
    ensure_local_folders(&conn, "pop").unwrap();
    let original = raw("retained");
    let first = insert_local(&conn, "pop", "INBOX", &original, &[]).unwrap();
    delete_local(&conn, "pop", "INBOX", Some(&[first.header.uid])).unwrap();
    let entries = storage::list(&conn, "pop", 0).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        storage::open_entry(&conn, "pop", &entries[0])
            .unwrap()
            .read()
            .unwrap(),
        original
    );
    storage::remove_entries(&conn, "pop", &entries).unwrap();
    let next = insert_local(&conn, "pop", "INBOX", &raw("next"), &[]).unwrap();
    assert!(next.header.uid > first.header.uid);
    delete_local(&conn, "pop", "INBOX", Some(&[next.header.uid])).unwrap();
    let retained = storage::list(&conn, "pop", 0).unwrap();
    assert_eq!(
        retained.len(),
        1,
        "cleaning an old UID must not suppress a new email"
    );
    assert_eq!(retained[0].uid, next.header.uid);
}
