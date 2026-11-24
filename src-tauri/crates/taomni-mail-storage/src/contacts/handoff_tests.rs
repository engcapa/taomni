use super::{
    CardChange, MailAddressBookEntry, StoredCard, delete_entry,
    handoff::{self, AddressBookImport},
    load_cards,
    mailbox::{BookAction, DavState},
    save_entry, store_card,
};
use crate::{cache::init_mail_tables, vcard::MailContactCard};
use rusqlite::Connection;
use serde_json::json;

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    init_mail_tables(&db).unwrap();
    db
}

fn card(uid: &str, name: &str) -> StoredCard {
    StoredCard {
        card: MailContactCard {
            uid: uid.into(),
            display_name: name.into(),
            emails: vec!["alice@example.org".into()],
            raw: Some(format!(
                "BEGIN:VCARD\r\nUID:{uid}\r\nX-KEEP:original\r\nEND:VCARD\r\n"
            )),
            ..Default::default()
        },
        book: "carddav".into(),
        href: Some(format!("/contacts/{uid}.vcf")),
        etag: Some("v1".into()),
        dirty: true,
        deleted: false,
    }
}

#[test]
fn ownership_is_atomic_keeps_tombstones_discovery_and_opaque_fields_and_does_not_resurrect() {
    let old = database();
    let mut db = database();
    let mut removed = card("deleted", "Deleted");
    removed.deleted = true;
    let live = card("live", "Live");
    for c in [&live, &removed] {
        store_card(&old, "a", c).unwrap();
    }
    store_card(&old, "b", &card("foreign", "Foreign")).unwrap();
    let dav = DavState {
        collection_url: Some("https://dav.example/a".into()),
        base_url: Some("https://dav.example".into()),
        last_sync: Some(10),
        last_error: None,
    };
    super::mailbox::save_state(&old, "a", dav).unwrap();
    store_card(&db, "a", &card("stale", "Deleted since staging")).unwrap();
    let source = || AddressBookImport {
        replace_staged: true,
        snapshot: handoff::read_account(&old, "a").unwrap(),
    };
    // A failed or cancelled initial write leaves staged rows intact.
    let tx = db.transaction().unwrap();
    handoff::adopt(&tx, "a", source()).unwrap();
    tx.rollback().unwrap();
    assert!(!handoff::is_owned(&db, "a").unwrap());
    assert_eq!(load_cards(&db, "a").unwrap()[0].card.uid, "stale");
    let tx = db.transaction().unwrap();
    handoff::adopt(&tx, "a", source()).unwrap();
    tx.commit().unwrap();
    assert_eq!(load_cards(&db, "a").unwrap(), vec![removed, live]);
    let state = super::mailbox::load_state(&db, "a").unwrap().unwrap();
    assert_eq!(
        state.collection_url.as_deref(),
        Some("https://dav.example/a")
    );
    assert!(!handoff::is_owned(&db, "b").unwrap());
    // A repeated first-use request must never restore a user's later delete.
    assert!(delete_entry(&db, "a", "live").unwrap());
    handoff::adopt(&db, "a", source()).unwrap();
    assert_eq!(BookAction::List.execute(&db, "a").unwrap(), json!([]));
    assert_eq!(
        load_cards(&old, "a")
            .unwrap()
            .iter()
            .filter(|c| !c.deleted)
            .count(),
        1
    );
}

#[test]
fn in_flight_carddav_results_preserve_a_new_edit_and_commit_uncontested_changes() {
    let db = database();
    let before = card("a", "Before");
    let obsolete = card("b", "Obsolete");
    store_card(&db, "account", &before).unwrap();
    store_card(&db, "account", &obsolete).unwrap();
    save_entry(
        &db,
        "account",
        MailAddressBookEntry {
            uid: "a".into(),
            display_name: "Edited while syncing".into(),
            ..Default::default()
        },
        "carddav",
    )
    .unwrap();
    let tx = db.unchecked_transaction().unwrap();
    BookAction::FinishSync {
        original: vec![before.clone(), obsolete],
        changes: vec![
            CardChange::Store(before),
            CardChange::Remove("b".into()),
            CardChange::Store(card("c", "Pull")),
        ],
        state: DavState {
            last_sync: Some(20),
            ..Default::default()
        },
    }
    .execute(&tx, "account")
    .unwrap();
    tx.commit().unwrap();
    let saved = load_cards(&db, "account").unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0].card.display_name, "Edited while syncing");
    assert!(saved[0].dirty);
    assert_eq!(saved[1].card.uid, "c");
    assert_eq!(
        super::mailbox::load_state(&db, "account")
            .unwrap()
            .unwrap()
            .last_sync,
        Some(20)
    );
}

#[test]
fn restored_mailbox_claims_its_own_contacts_and_empty_legacy_schema_can_be_adopted() {
    let db = database();
    let restored = card("restored", "Restored");
    store_card(&db, "account", &restored).unwrap();
    let old = Connection::open_in_memory().unwrap();
    handoff::adopt(
        &db,
        "account",
        AddressBookImport {
            replace_staged: false,
            snapshot: handoff::read_account(&old, "account").unwrap(),
        },
    )
    .unwrap();
    assert!(handoff::is_owned(&db, "account").unwrap());
    assert_eq!(load_cards(&db, "account").unwrap(), vec![restored]);
}
