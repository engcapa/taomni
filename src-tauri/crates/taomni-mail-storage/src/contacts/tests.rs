use super::suggestions::{address_book_suggestions, merge_suggestions};
use super::*;
use crate::cache::{MailContactSuggestion, init_mail_tables};
use rusqlite::Connection;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    conn
}

fn card_text(uid: &str, name: &str, email: &str) -> String {
    format!(
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{uid}\r\nFN:{name}\r\nEMAIL:{email}\r\nX-CUSTOM:keep\r\nEND:VCARD\r\n"
    )
}

#[test]
fn local_entries_suggestions_and_files() {
    let conn = db();
    let saved = save_entry(
        &conn,
        "acct",
        MailAddressBookEntry {
            display_name: "Jane Doe".into(),
            emails: vec![" jane@example.com ".into()],
            ..Default::default()
        },
        "local",
    )
    .unwrap();
    assert!(!saved.uid.is_empty());
    assert_eq!(saved.book, "local");
    assert!(!saved.pending_sync);
    assert!(save_entry(&conn, "acct", MailAddressBookEntry::default(), "local").is_err());
    let bad = MailAddressBookEntry {
        display_name: "x".into(),
        emails: vec!["nope".into()],
        ..Default::default()
    };
    assert!(
        save_entry(&conn, "acct", bad, "local")
            .unwrap_err()
            .to_string()
            .contains("not an email")
    );

    let hits = address_book_suggestions(&conn, "acct", "doe", 5).unwrap();
    assert_eq!(hits[0].email, "jane@example.com");
    assert_eq!(hits[0].source, "addressBook");
    let collected = vec![MailContactSuggestion {
        name: None,
        email: "JANE@example.com".into(),
        source: "history".into(),
        score: 10,
        last_seen_at: None,
    }];
    assert_eq!(
        merge_suggestions(hits, collected, 5).len(),
        1,
        "dedupe by email"
    );

    assert_eq!(
        import_cards(
            &conn,
            "acct",
            &card_text("imp-1", "Imported", "imp@example.com"),
            "local"
        )
        .unwrap(),
        1
    );
    let (text, count) = export_cards(&conn, "acct").unwrap();
    assert_eq!(count, 2);
    assert!(text.contains("UID:imp-1") && text.contains("X-CUSTOM:keep"));
    assert!(delete_entry(&conn, "acct", &saved.uid).unwrap());
    assert_eq!(load_cards(&conn, "acct").unwrap().len(), 1);
}

#[test]
fn paged_address_book_preserves_sorting_and_hides_tombstones_and_other_accounts() {
    let conn = db();
    for (account, name) in [("acct", "Zed"), ("acct", "Alice"), ("other", "Aaron")] {
        save_entry(
            &conn,
            account,
            MailAddressBookEntry {
                display_name: name.into(),
                ..Default::default()
            },
            "local",
        )
        .unwrap();
    }
    let deleted = StoredCard {
        card: crate::vcard::MailContactCard {
            uid: "deleted".into(),
            display_name: "Abby".into(),
            emails: vec!["hidden@example.com".into()],
            ..Default::default()
        },
        book: "carddav".into(),
        href: Some("deleted.vcf".into()),
        etag: Some("one".into()),
        dirty: false,
        deleted: false,
    };
    store_card(&conn, "acct", &deleted).unwrap();
    assert!(delete_entry(&conn, "acct", "deleted").unwrap());

    let first = list_entries_page(&conn, "acct", 1, 0).unwrap();
    let second = list_entries_page(&conn, "acct", 1, 1).unwrap();
    assert_eq!(first[0].display_name, "Alice");
    assert_eq!(second[0].display_name, "Zed");
    assert_eq!(entries(&conn, "acct").unwrap(), [first, second].concat());
    assert!(list_entries_page(&conn, "acct", 1, 2).unwrap().is_empty());
    assert!(
        search_recipient_suggestions(&conn, "acct", "hidden", 8)
            .unwrap()
            .is_empty()
    );
    let pending = load_cards(&conn, "acct").unwrap().remove(0);
    assert_eq!(pending.card.uid, "deleted");
    assert!(pending.deleted && pending.dirty);
    assert_eq!(pending.etag.as_deref(), Some("one"));
}
