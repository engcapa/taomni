use super::index::object_path;
use super::publication::verify_object;
use super::reading::{export, read, read_entry};
use super::*;
use crate::database::mail_db_file_stem;
use rusqlite::Connection;
use std::fs;
#[cfg(windows)]
use std::path::PathBuf;

#[test]
fn default_storage_publishes_long_paths_and_preserves_complete_mime() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().to_path_buf();
    // Start with the ordinary profile path, just like a Quick Connect
    // mailbox. A pre-canonicalized test directory would mask the bug.
    #[cfg(windows)]
    let base = PathBuf::from(
        base.to_str()
            .unwrap()
            .strip_prefix(r"\\?\")
            .unwrap_or(base.to_str().unwrap()),
    );
    let padding = 145usize.saturating_sub(base.as_os_str().len() + 1);
    let profile = base.join("p".repeat(padding.max(1)));
    fs::create_dir_all(&profile).unwrap();
    let account = format!("quick-mail-{}@example.test_993", "account".repeat(12));
    let db_path = profile.join(format!("{}.db", mail_db_file_stem(&account)));
    #[cfg(windows)]
    assert!(db_path.as_os_str().len() < 260);
    let db = Connection::open(&db_path).unwrap();
    crate::cache::init_cache_tables(&db).unwrap();
    init_tables(&db).unwrap();
    let raw = b"Subject: full MIME on long paths\r\nContent-Type: multipart/mixed; boundary=qa\r\n\r\n--qa\r\nContent-Type: text/plain\r\n\r\nbody\r\n--qa\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nYXR0YWNobWVudA==\r\n--qa--\r\n";
    let stored = store(&db, &account, "INBOX", 1, 10, raw.as_slice()).unwrap();
    let path = object_path(&account_root(&db, &account).unwrap(), &stored.hash).unwrap();
    assert!(path.as_os_str().len() > 260);
    assert!(path.exists());
    assert_eq!(read(&db, &account, "INBOX", 1).unwrap().unwrap(), raw);
    let duplicate = store(&db, &account, "INBOX", 2, 10, raw.as_slice()).unwrap();
    assert_eq!(duplicate.hash, stored.hash);
    db.execute("DELETE FROM mail_full_messages", []).unwrap();
    assert_eq!(collect_garbage(&db, &account).unwrap(), 1);
    assert!(!path.exists());
}

#[test]
fn full_mime_round_trip_deduplicates_and_physically_removes_last_reference() {
    let directory = tempfile::tempdir().unwrap();
    let db = Connection::open(directory.path().join("qa.db")).unwrap();
    crate::cache::init_cache_tables(&db).unwrap();
    init_tables(&db).unwrap();
    for uid in [1, 2] {
        db.execute(
            "INSERT INTO mail_messages(account_id,folder,uid,updated_at) VALUES('qa','INBOX',?1,0)",
            [uid],
        )
        .unwrap();
    }
    let raw = format!(
        "From: a@example.test\r\nSubject: complete\r\n\r\n{}",
        "body and attachment bytes\r\n".repeat(20000)
    )
    .into_bytes();
    let first = store(&db, "qa", "INBOX", 1, 10, raw.as_slice()).unwrap();
    let second = store(&db, "qa", "INBOX", 2, 10, raw.as_slice()).unwrap();
    assert_eq!(first.hash, second.hash);
    assert!(first.stored_size < first.raw_size / 10);
    assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
    db.execute("DELETE FROM mail_messages WHERE uid=1", [])
        .unwrap();
    assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
    db.execute("DELETE FROM mail_full_messages WHERE uid=1", [])
        .unwrap();
    assert_eq!(collect_garbage(&db, "qa").unwrap(), 0);
    let opened = open(&db, "qa", "INBOX", 2).unwrap().unwrap();
    let snapshot = directory.path().join("snapshot");
    let pinned = snapshot_objects(&db, "qa", &snapshot).unwrap();
    db.execute("DELETE FROM mail_messages WHERE uid=2", [])
        .unwrap();
    db.execute("DELETE FROM mail_full_messages WHERE uid=2", [])
        .unwrap();
    assert_eq!(collect_garbage(&db, "qa").unwrap(), 1);
    // In-flight readers retain their descriptor across explicit cleanup.
    assert_eq!(opened.read().unwrap(), raw);
    assert!(
        !object_path(&account_root(&db, "qa").unwrap(), &first.hash)
            .unwrap()
            .exists()
    );
    verify_object(&pinned[0].1, &first.hash, first.raw_size, std::io::sink()).unwrap();
}

#[test]
fn uidvalidity_and_cleanup_keep_history_separate_from_current_mail() {
    let directory = tempfile::tempdir().unwrap();
    let db = Connection::open(directory.path().join("qa.db")).unwrap();
    crate::cache::init_cache_tables(&db).unwrap();
    init_tables(&db).unwrap();
    db.execute("INSERT INTO mail_folders(account_id,name,uid_validity,updated_at) VALUES('qa','INBOX',10,0)",[]).unwrap();
    store(&db, "qa", "INBOX", 1, 10, &b"Subject: old\r\n\r\nold"[..]).unwrap();
    db.execute("UPDATE mail_folders SET uid_validity=20", [])
        .unwrap();
    assert!(read(&db, "qa", "INBOX", 1).unwrap().is_none());
    store(&db, "qa", "INBOX", 1, 20, &b"Subject: new\r\n\r\nnew"[..]).unwrap();
    let entries = list(&db, "qa", 0).unwrap();
    assert_eq!(entries.len(), 2);
    let old = entries
        .iter()
        .find(|e| e.uid_validity == 10)
        .unwrap()
        .clone();
    assert!(
        String::from_utf8(read_entry(&db, "qa", &old).unwrap())
            .unwrap()
            .contains("old")
    );
    assert_eq!(remove_entries(&db, "qa", &[old]).unwrap(), 1);
    assert_eq!(list(&db, "qa", 0).unwrap().len(), 1);
    assert!(
        String::from_utf8(read(&db, "qa", "INBOX", 1).unwrap().unwrap())
            .unwrap()
            .contains("new")
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM mail_archive_skipped", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn damaged_object_never_replaces_an_exported_email() {
    let directory = tempfile::tempdir().unwrap();
    let db = Connection::open(directory.path().join("qa.db")).unwrap();
    crate::cache::init_cache_tables(&db).unwrap();
    init_tables(&db).unwrap();
    let entry = store(
        &db,
        "qa",
        "INBOX",
        1,
        10,
        &b"Subject: test\r\n\r\ncomplete"[..],
    )
    .unwrap();
    fs::write(
        object_path(&account_root(&db, "qa").unwrap(), &entry.hash).unwrap(),
        b"broken",
    )
    .unwrap();
    let target = directory.path().join("saved.eml");
    fs::write(&target, b"previous working export").unwrap();
    assert!(export(&db, "qa", "INBOX", 1, &target).is_err());
    assert_eq!(fs::read(target).unwrap(), b"previous working export");
    assert!(object_path(directory.path(), "../escape").is_err());
}
