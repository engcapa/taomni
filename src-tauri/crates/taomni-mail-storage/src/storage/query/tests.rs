use super::*;
#[cfg(feature = "mime-parse")]
use crate::storage;
fn fixture() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let db = Connection::open(dir.path().join("qa.db")).unwrap();
    crate::cache::init_cache_tables(&db).unwrap();
    crate::storage::init_tables(&db).unwrap();
    (dir, db)
}
fn add(db: &Connection, uid: u32, folder: &str, subject: &str, hash: &str) {
    let header = serde_json::json!({"subject":subject,"from":{"name":"Alice","address":"alice@example.com"},"to":[{"address":"reader@example.com"}],"cc":[],"dateTs":100+uid,"hasAttachments":uid%2==0,"bodyCached":true});
    db.execute(
        "INSERT INTO mail_full_messages VALUES('qa',?1,?2,10,?3,?4,?5,?6,?7)",
        params![
            folder,
            uid,
            hash,
            1000 + uid,
            100 + uid,
            200 + uid,
            header.to_string()
        ],
    )
    .unwrap();
}
fn key(uid: u32, folder: &str) -> ArchiveKey {
    ArchiveKey {
        folder: folder.into(),
        uid,
        uid_validity: 10,
    }
}
#[test]
fn indexed_filters_search_literal_unicode_and_paginate_whole_archive() {
    let (_dir, db) = fixture();
    for uid in 1..=450 {
        add(
            &db,
            uid,
            if uid <= 400 { "INBOX" } else { "&U,BTFw-" },
            &format!("Invoice 台北 {uid:04}"),
            "hash",
        );
    }
    let q = ArchiveQuery {
        text: "Invoice".into(),
        folder: Some("INBOX".into()),
        sort: ArchiveSort::Largest,
        ..Default::default()
    };
    let result = query(&db, "qa", &q, 200).unwrap();
    assert_eq!(result.total, 400);
    assert_eq!(result.entries.len(), 200);
    assert_eq!(result.entries[0].entry.uid, 200);
    for text in [
        "台北",
        "Invoice 台北",
        "ALICE@EXAMPLE.COM",
        "reader@example.com",
    ] {
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    text: text.into(),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            450
        );
    }
    assert_eq!(query(&db, "other", &q, 0).unwrap().total, 0);
    add(&db, 451, "INBOX", "Literal 100% _ \"quoted\"", "hash");
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                text: "100% _ \"quoted\"".into(),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        1
    );
    let q = ArchiveQuery {
        date_from: Some(110),
        date_before: Some(121),
        min_size: Some(1012),
        max_size: Some(1018),
        has_attachments: Some(true),
        stored_from: Some(214),
        stored_before: Some(218),
        ..Default::default()
    };
    let result = query(&db, "qa", &q, 9999).unwrap();
    assert_eq!(result.total, 2);
    assert_eq!(result.offset, 0);
    assert!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                min_size: Some(20),
                max_size: Some(10),
                ..Default::default()
            },
            0
        )
        .is_err()
    );
    let plan:String=db.query_row("EXPLAIN QUERY PLAN SELECT * FROM mail_archive_index WHERE account_id='qa' AND folder='INBOX' ORDER BY stored_at DESC LIMIT 200",[],|r|r.get(3)).unwrap();
    assert!(plan.contains("mail_archive_folder_saved"), "{plan}");
    db.execute("UPDATE mail_full_messages SET header_json=json_set(header_json,'$.subject','Changed subject') WHERE uid=451",[]).unwrap();
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                text: "quoted".into(),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        0
    );
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                text: "Changed".into(),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        1
    );
}
#[test]
fn previews_freeze_membership_respect_shared_objects_and_exclusions() {
    let (_dir, db) = fixture();
    add(&db, 1, "INBOX", "Keep shared", "shared");
    add(&db, 2, "Archive", "Shared copy", "shared");
    add(&db, 3, "INBOX", "Unique", "unique");
    let p = preview(
        &db,
        "qa",
        &ArchiveSelection {
            query: Some(ArchiveQuery {
                folder: Some("INBOX".into()),
                ..Default::default()
            }),
            keys: vec![],
            excluded: vec![],
        },
    )
    .unwrap();
    assert_eq!(p.count, 2);
    assert_eq!(p.reclaimable_bytes, 103);
    add(&db, 4, "INBOX", "Arrived after preview", "new");
    // Invalid object hashes are deliberately absent; removing mappings is verified independently.
    db.execute("DROP TRIGGER mail_full_object_unreferenced", [])
        .unwrap();
    assert_eq!(remove_preview(&db, "qa", &p.token).unwrap(), 2);
    assert_eq!(
        query(&db, "qa", &ArchiveQuery::default(), 0).unwrap().total,
        2
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM mail_archive_skipped", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(remove_preview(&db, "qa", &p.token).is_err());
    let p = preview(
        &db,
        "qa",
        &ArchiveSelection {
            query: Some(ArchiveQuery::default()),
            keys: vec![],
            excluded: vec![key(4, "INBOX")],
        },
    )
    .unwrap();
    assert_eq!(p.count, 1);
    assert_eq!(p.reclaimable_bytes, 102);
    assert!(remove_preview(&db, "other", &p.token).is_err());
    db.execute(
        "UPDATE mail_full_messages SET sha256='replacement' WHERE uid=2",
        [],
    )
    .unwrap();
    assert!(
        remove_preview(&db, "qa", &p.token)
            .unwrap_err()
            .contains("changed")
    );
    assert_eq!(
        query(&db, "qa", &ArchiveQuery::default(), 0).unwrap().total,
        2
    );
}
#[cfg(feature = "mime-parse")]
#[test]
fn attachment_metadata_is_built_from_mime_and_migrated_for_old_snapshots() {
    let (_dir, db) = fixture();
    db.execute(
        "INSERT INTO mail_messages(account_id,folder,uid,updated_at) VALUES('qa','INBOX',1,0)",
        [],
    )
    .unwrap();
    let raw=b"Subject: Attachments\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nbody\r\n--x\r\nContent-Disposition: attachment; filename=a.bin\r\n\r\nbytes\r\n--x--\r\n";
    storage::store(&db, "qa", "INBOX", 1, 10, raw.as_slice()).unwrap();
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                has_attachments: Some(true),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        1
    );
    db.execute_batch("DROP TRIGGER mail_archive_index_insert;DROP TRIGGER mail_archive_index_update;DROP TRIGGER mail_archive_index_delete;DROP TABLE mail_archive_search;DROP TABLE mail_archive_index;").unwrap();
    db.execute(
        "UPDATE mail_full_messages SET header_json=json_set(header_json,'$.hasAttachments',0)",
        [],
    )
    .unwrap();
    init_index(&db).unwrap();
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                has_attachments: Some(true),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        1
    );
    // The rebuild is complete: later queries depend only on the index.
    db.execute("DELETE FROM mail_messages", []).unwrap();
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                has_attachments: Some(true),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        1
    );
}

#[test]
fn legacy_archive_migrates_once_and_retains_search_after_header_cache_deletion() {
    let (_dir, db) = fixture();
    add(&db, 1, "INBOX", "Legacy searchable", "hash");
    db.execute_batch("DROP TRIGGER mail_archive_index_insert;DROP TRIGGER mail_archive_index_update;DROP TRIGGER mail_archive_index_delete;DROP TABLE mail_archive_search;DROP TABLE mail_archive_index;").unwrap();
    init_index(&db).unwrap();
    init_index(&db).unwrap();
    db.execute("DELETE FROM mail_messages", []).unwrap();
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                text: "searchable".into(),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        1
    );
    db.execute("DELETE FROM mail_full_messages", []).unwrap();
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                text: "searchable".into(),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        0
    );
}

#[cfg(not(feature = "mime-parse"))]
#[test]
fn pre_index_database_defers_attachment_backfill_without_mime_parse() {
    use flate2::{Compression, write::GzEncoder};
    use sha2::{Digest, Sha256};
    use std::{fs, io::Write};

    let (_dir, db) = fixture();
    let raw = b"Subject: Attachments\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nbody\r\n--x\r\nContent-Disposition: attachment; filename=a.bin\r\n\r\nbytes\r\n--x--\r\n";
    let hash = hex::encode(Sha256::digest(raw));
    let root = crate::storage::account_root(&db, "qa").unwrap();
    let object = crate::storage::object_path(&root, &hash).unwrap();
    fs::create_dir_all(object.parent().unwrap()).unwrap();
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(3));
    encoder.write_all(raw).unwrap();
    let gz = encoder.finish().unwrap();
    fs::write(&object, &gz).unwrap();

    db.execute_batch("DROP TRIGGER mail_archive_index_insert;DROP TRIGGER mail_archive_index_update;DROP TRIGGER mail_archive_index_delete;DROP TABLE mail_archive_search;DROP TABLE mail_archive_index;").unwrap();
    db.execute(
        "INSERT INTO mail_full_messages VALUES('qa','INBOX',1,10,?1,?2,?3,200,'{\"subject\":\"Attachments\",\"hasAttachments\":false}')",
        params![hash, raw.len() as i64, gz.len() as i64],
    )
    .unwrap();

    init_index(&db).unwrap();
    let marker: Option<String> = db
        .query_row(
            "SELECT value FROM mail_archive_meta WHERE key='legacy_attachment_backfill_pending'",
            [],
            |r| r.get(0),
        )
        .ok();
    assert_eq!(marker.as_deref(), Some("1"));
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                text: "Attachments".into(),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        1
    );
}

#[cfg(feature = "mime-parse")]
#[test]
fn deferred_attachment_backfill_completes_when_mime_parse_opens_indexed_db() {
    let (_dir, db) = fixture();
    db.execute(
        "INSERT INTO mail_messages(account_id,folder,uid,updated_at) VALUES('qa','INBOX',1,0)",
        [],
    )
    .unwrap();
    let raw = b"Subject: Attachments\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nbody\r\n--x\r\nContent-Disposition: attachment; filename=a.bin\r\n\r\nbytes\r\n--x--\r\n";
    storage::store(&db, "qa", "INBOX", 1, 10, raw.as_slice()).unwrap();
    // Simulate an unflagged legacy index created by core without `mime-parse`.
    db.execute(
        "UPDATE mail_full_messages SET header_json=json_set(header_json,'$.hasAttachments',0)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT OR REPLACE INTO mail_archive_meta(key, value) VALUES('legacy_attachment_backfill_pending', '1')",
        [],
    )
    .unwrap();
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                has_attachments: Some(true),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        0
    );

    complete_pending_attachment_backfill(&db).unwrap();
    assert_eq!(
        query(
            &db,
            "qa",
            &ArchiveQuery {
                has_attachments: Some(true),
                ..Default::default()
            },
            0
        )
        .unwrap()
        .total,
        1
    );
    let pending: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM mail_archive_meta WHERE key='legacy_attachment_backfill_pending')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!pending);
}
