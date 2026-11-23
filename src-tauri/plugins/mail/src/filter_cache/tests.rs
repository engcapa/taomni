use std::path::Path;

use rusqlite::{Connection, params};
use taomni_mail_engine::{
    cache::{init_mail_tables, upsert_message},
    database::mail_db_file_stem,
    filters::filter_mark,
    parse_body_message,
};

use super::*;

const ACCOUNT: &str = "filter-cache-account";

fn request(path: &Path, action: FilterCacheAction) -> ImapFilterCacheRequest {
    ImapFilterCacheRequest {
        account_id: ACCOUNT.into(),
        database: path.to_owned(),
        action,
    }
}

#[test]
fn baseline_and_advance_keep_the_latest_mark_in_its_uid_generation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    db.execute(
        "INSERT INTO mail_folders (account_id, name, uid_validity, updated_at)
         VALUES (?1, 'INBOX', 7, 1)",
        params![ACCOUNT],
    )
    .unwrap();
    let add = |uid| {
        let raw = b"Subject: Filter candidate\r\n\r\nCandidate body";
        let body = parse_body_message(ACCOUNT, "INBOX", uid, None, raw, raw.len());
        upsert_message(&db, &body).unwrap();
    };
    add(2);
    apply(
        request(
            &path,
            FilterCacheAction::Baseline {
                folder: "INBOX".into(),
            },
        ),
        &|| Ok(()),
    )
    .unwrap();
    add(3);
    add(4);
    let snapshot = apply(
        request(
            &path,
            FilterCacheAction::Candidates {
                folder: "INBOX".into(),
                incoming: true,
                uids: None,
            },
        ),
        &|| Ok(()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(snapshot.uid_validity, Some(7));
    assert_eq!(
        snapshot
            .messages
            .iter()
            .map(|(message, _)| message.uid)
            .collect::<Vec<_>>(),
        [3, 4]
    );
    let advance = |uid| {
        apply(
            request(
                &path,
                FilterCacheAction::Advance {
                    folder: "INBOX".into(),
                    uid,
                    uid_validity: snapshot.uid_validity,
                },
            ),
            &|| Ok(()),
        )
        .unwrap()
    };
    advance(4);
    advance(3);
    assert_eq!(filter_mark(&db, ACCOUNT, "INBOX").unwrap(), Some(4));
    db.execute("UPDATE mail_folders SET uid_validity=8", [])
        .unwrap();
    advance(5);
    assert_eq!(filter_mark(&db, ACCOUNT, "INBOX").unwrap(), None);
}
