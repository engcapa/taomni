//! Select and commit a background IMAP body fetch against one mailbox generation.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use super::{cached_header, upsert_message_at};
use crate::{MailMessageCached, storage};

pub fn pending_bodies(
    db: &Connection,
    account: &str,
    folder: &str,
    uids: Vec<u32>,
) -> rusqlite::Result<(Vec<u32>, Option<u32>)> {
    let tx = db.unchecked_transaction()?;
    let validity = folder_uid_validity(&tx, account, folder)?;
    let mut pending = Vec::new();
    for uid in uids {
        if cached_header(&tx, account, folder, uid)?.is_some_and(|header| !header.body_cached)
            && storage::lookup(&tx, account, folder, uid)
                .map_err(storage::as_sql_error)?
                .is_none()
        {
            pending.push(uid);
        }
    }
    tx.commit()?;
    Ok((pending, validity))
}

fn folder_uid_validity(
    db: &Connection,
    account: &str,
    folder: &str,
) -> rusqlite::Result<Option<u32>> {
    db.query_row(
        "SELECT uid_validity FROM mail_folders WHERE account_id = ?1 AND name = ?2",
        params![account, folder],
        |row| row.get(0),
    )
    .optional()
    .map(Option::flatten)
}

pub fn cache_body_if_current(
    db: &Connection,
    message: MailMessageCached,
    uid_validity: Option<u32>,
    observed_at: i64,
) -> rusqlite::Result<bool> {
    // A second connection can synchronize this folder or open the message while
    // the IMAP request is in flight. Hold the SQLite writer lock through commit.
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let applied = cache_body_if_current_in_transaction(&tx, message, uid_validity, observed_at)?;
    if applied {
        tx.commit()?;
    }
    Ok(applied)
}

/// The caller holds the writer transaction and can check cancellation at commit.
pub fn cache_body_if_current_in_transaction(
    db: &Connection,
    mut message: MailMessageCached,
    uid_validity: Option<u32>,
    observed_at: i64,
) -> rusqlite::Result<bool> {
    let header = &mut message.header;
    if folder_uid_validity(db, &header.account_id, &header.folder)? != uid_validity {
        return Ok(false);
    }
    let Some(current) = cached_header(db, &header.account_id, &header.folder, header.uid)? else {
        return Ok(false);
    };
    if current.body_cached
        || storage::lookup(db, &header.account_id, &header.folder, header.uid)
            .map_err(storage::as_sql_error)?
            .is_some()
        || matches!((&current.message_id, &header.message_id), (Some(current), Some(fetched)) if current != fetched)
    {
        return Ok(false);
    }
    // Sync and local actions own flags. A late prefetch only fills the body.
    header.flags = current.flags;
    upsert_message_at(db, &message, Some(observed_at))?;
    Ok(true)
}

#[cfg(all(test, feature = "mime-parse"))]
mod tests {
    use super::*;
    use crate::{
        cache::{get_cached_body, init_mail_tables},
        parse_body_message,
    };

    #[test]
    fn prefetch_preserves_replaced_headers_read_flags_and_existing_bodies() {
        let db = Connection::open_in_memory().unwrap();
        init_mail_tables(&db).unwrap();
        db.execute(
            "INSERT INTO mail_folders (account_id, name, uid_validity, updated_at)
             VALUES ('qa', 'INBOX', 7, 1)",
            [],
        )
        .unwrap();
        let raw = b"From: qa@example.test\r\nSubject: Warm\r\nMessage-ID: <warm@example.test>\r\n\r\nRecently delivered";
        let mut fetched = parse_body_message("qa", "INBOX", 1, None, raw, raw.len());

        assert!(!cache_body_if_current(&db, fetched.clone(), Some(7), 1).unwrap());

        let mut header_only = fetched.clone();
        header_only.body_cached_at = None;
        header_only.body_text = None;
        header_only.body_html = None;
        header_only.header.flags = vec!["\\Seen".into()];
        upsert_message_at(&db, &header_only, None).unwrap();
        assert!(!cache_body_if_current(&db, fetched.clone(), Some(6), 1).unwrap());
        assert!(cache_body_if_current(&db, fetched.clone(), Some(7), 1).unwrap());
        fetched.body_text = Some("Superseded body".into());
        assert!(!cache_body_if_current(&db, fetched, Some(7), 1).unwrap());

        let current = cached_header(&db, "qa", "INBOX", 1).unwrap().unwrap();
        assert_eq!(current.flags, ["\\Seen"]);
        let body = get_cached_body(&db, "qa", "INBOX", 1).unwrap().unwrap();
        assert_eq!(body.text.as_deref(), Some("Recently delivered"));
    }

    #[test]
    fn another_mailbox_connection_can_replace_or_archive_a_message_during_prefetch() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.db");
        let reader = Connection::open(&path).unwrap();
        init_mail_tables(&reader).unwrap();
        let writer = Connection::open(&path).unwrap();
        writer
            .execute(
                "INSERT INTO mail_folders (account_id, name, uid_validity, updated_at)
             VALUES ('qa', 'INBOX', 7, 1)",
                [],
            )
            .unwrap();
        let raw = b"Subject: original\r\nMessage-ID: <original@example.test>\r\n\r\nBody";
        let message = parse_body_message("qa", "INBOX", 3, None, raw, raw.len());
        let mut header = message.clone();
        header.body_cached_at = None;
        header.body_text = None;
        upsert_message_at(&writer, &header, None).unwrap();
        let (uids, generation) = pending_bodies(&reader, "qa", "INBOX", vec![2, 3]).unwrap();
        assert_eq!(uids, [3]);
        assert_eq!(generation, Some(7));

        writer
            .execute("UPDATE mail_folders SET uid_validity = 8", [])
            .unwrap();
        assert!(!cache_body_if_current(&reader, message.clone(), generation, 2).unwrap());
        writer
            .execute("UPDATE mail_messages SET message_id = 'replacement'", [])
            .unwrap();
        assert!(!cache_body_if_current(&reader, message.clone(), Some(8), 3).unwrap());
        upsert_message_at(&writer, &header, None).unwrap();
        storage::store(&writer, "qa", "INBOX", 3, 8, raw.as_slice()).unwrap();
        assert!(!cache_body_if_current(&reader, message, Some(8), 4).unwrap());
        assert!(
            pending_bodies(&reader, "qa", "INBOX", vec![3])
                .unwrap()
                .0
                .is_empty()
        );
        assert!(
            !cached_header(&reader, "qa", "INBOX", 3)
                .unwrap()
                .unwrap()
                .body_cached
        );
    }
}
