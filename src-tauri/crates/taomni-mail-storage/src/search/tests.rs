use super::*;
use crate::{
    MailAddress, MailMessageCached,
    cache::{init_mail_tables, upsert_message},
};

fn header(folder: &str, uid: u32, subject: &str, from: &str, flags: &[&str]) -> MailMessageCached {
    MailMessageCached {
        header: MailMessageHeader {
            account_id: "acct".into(),
            folder: folder.into(),
            uid,
            message_id: Some(format!("{uid}@x")),
            subject: subject.into(),
            from: Some(MailAddress {
                name: Some(from.into()),
                address: Some(format!("{}@example.com", from.to_lowercase())),
            }),
            to: vec![],
            cc: vec![],
            date_ts: Some(uid as i64),
            flags: flags.iter().map(|flag| flag.to_string()).collect(),
            has_attachments: uid % 2 == 0,
            attachment_count: (uid % 2 == 0) as usize,
            attachments: vec![],
            snippet: Some(format!("snippet for {subject}")),
            raw_size: None,
            body_cached: false,
            in_reply_to: None,
            references: vec![],
            list_unsubscribe: None,
            receipt_to: None,
        },
        body_text: None,
        body_html: None,
        body_cached_at: None,
        internal_ts: None,
        flags_authoritative: true,
    }
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    for message in [
        header("INBOX", 1, "Quarterly budget review", "Alice", &["\\Seen"]),
        header("INBOX", 2, "季度预算评审会议", "Bob", &[]),
        header("INBOX", 3, "Lunch?", "Carol", &["\\Flagged", "$label1"]),
        header("Archive", 4, "Old budget notes", "Alice", &["\\Seen"]),
    ] {
        upsert_message(&conn, &message).unwrap();
    }
    conn
}

fn uids(results: Vec<MailMessageHeader>) -> Vec<u32> {
    results.into_iter().map(|m| m.uid).collect()
}

fn query(text: &str) -> MailSearchQuery {
    MailSearchQuery {
        text: text.into(),
        ..MailSearchQuery::default()
    }
}

#[test]
fn full_text_search_spans_folders_and_supports_cjk() {
    let conn = db();
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &query("budget")).unwrap()),
        vec![4, 1]
    );
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &query("预算评审")).unwrap()),
        vec![2]
    );
    let scoped = MailSearchQuery {
        folder: Some("INBOX".into()),
        ..query("budget")
    };
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &scoped).unwrap()),
        vec![1]
    );
}

#[test]
fn field_filters_and_short_terms() {
    let conn = db();
    let sender = MailSearchQuery {
        field: MailSearchField::Sender,
        ..query("alice")
    };
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &sender).unwrap()),
        vec![4, 1]
    );
    // Two-character terms fall back to LIKE.
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &query("季度")).unwrap()),
        vec![2]
    );
    let unread = MailSearchQuery {
        unread_only: true,
        ..query("")
    };
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &unread).unwrap()),
        vec![3, 2]
    );
    let flagged = MailSearchQuery {
        flagged_only: true,
        ..query("")
    };
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &flagged).unwrap()),
        vec![3]
    );
    let tagged = MailSearchQuery {
        keyword: Some("$label1".into()),
        ..query("")
    };
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &tagged).unwrap()),
        vec![3]
    );
    let attachments = MailSearchQuery {
        with_attachments: true,
        ..query("")
    };
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &attachments).unwrap()),
        vec![4, 2]
    );
}

#[test]
fn index_follows_updates_and_deletes() {
    let conn = db();
    conn.execute(
        "UPDATE mail_messages SET body_text = 'contains the zebra keyword' WHERE uid = 3",
        [],
    )
    .unwrap();
    assert_eq!(
        uids(search_cached_messages(&conn, "acct", &query("zebra")).unwrap()),
        vec![3]
    );
    conn.execute("DELETE FROM mail_messages WHERE uid = 3", [])
        .unwrap();
    assert!(
        search_cached_messages(&conn, "acct", &query("zebra"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn quoted_phrases_and_fts_syntax_are_literal() {
    assert_eq!(
        search_terms(r#"budget "review meeting" x"#),
        vec!["budget", "review meeting", "x"]
    );
    let conn = db();
    // FTS operators in user text must not break the query.
    assert!(
        search_cached_messages(&conn, "acct", &query("NOT AND (budget"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn imap_criteria() {
    let (utf8, criteria) = imap_search_criteria(&MailSearchQuery {
        unread_only: true,
        ..query("budget \"q1 plan\"")
    });
    assert!(!utf8);
    assert_eq!(criteria, "TEXT \"budget\" TEXT \"q1 plan\" UNSEEN");
    let (utf8, criteria) = imap_search_criteria(&query("预算"));
    assert!(utf8);
    assert_eq!(criteria, "CHARSET UTF-8 TEXT \"预算\"");
    assert_eq!(imap_search_criteria(&query("")).1, "ALL");
}
