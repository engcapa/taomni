use std::cell::Cell;

use rusqlite::Connection;
use taomni_mail_engine::{
    cache::{init_mail_tables, search_contacts},
    database::mail_db_file_stem,
};

use super::*;

#[test]
fn sent_contacts_commit_once_per_recipient_and_roll_back_on_cancellation() {
    let account_id = "sent-contacts";
    let folder = tempfile::tempdir().unwrap();
    let database = folder
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(account_id)));
    let db = Connection::open(&database).unwrap();
    init_mail_tables(&db).unwrap();
    let request = || SentContactsUpdate {
        account_id: account_id.into(),
        database: database.clone(),
        recipients: vec![
            "Named Recipient <alice@example.com>".into(),
            "ALICE@example.com".into(),
            "Blind Copy <bcc@example.com>".into(),
        ],
    };
    let checks = Cell::new(0);
    assert!(
        record(request(), &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 4 {
                Err(RpcError::from_code(ErrorCode::RequestCancelled))
            } else {
                Ok(())
            }
        })
        .is_err()
    );
    assert!(
        search_contacts(&db, account_id, "example.com", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(record(request(), &|| Ok(())).unwrap(), 2);
    let contacts = search_contacts(&db, account_id, "example.com", 10).unwrap();
    assert_eq!(contacts.len(), 2);
    let recorded_once: u32 = db
        .query_row(
            "SELECT count(*) FROM mail_contacts WHERE account_id = ?1 AND sent_count = 1",
            [account_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recorded_once, 2);
    assert!(contacts.iter().any(|contact| {
        contact.email == "bcc@example.com" && contact.name.as_deref() == Some("Blind Copy")
    }));
    assert!(
        search_contacts(&db, "other-account", "example.com", 10)
            .unwrap()
            .is_empty()
    );
}
