use super::{HeaderInput, parse_header};

#[test]
fn fetched_headers_keep_transport_metadata_and_optional_headers() {
    let data = b"Subject: Updates\r\nMessage-ID: <message@example.test>\r\n\
                 References: <original@example.test>\r\n\
                 List-Unsubscribe: <https://lists.example.test/unsubscribe>\r\n\
                 List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\
                 Disposition-Notification-To: Sender <sender@example.test>\r\n\r\n";
    let parsed = parse_header(HeaderInput {
        account_id: "account",
        folder: "INBOX",
        uid: 19,
        header: data,
        flags: vec!["\\Seen".into()],
        internal_date: Some(200),
        raw_size: Some(720),
    });
    let header = parsed.header;
    assert_eq!(
        (
            header.account_id.as_str(),
            header.folder.as_str(),
            header.uid
        ),
        ("account", "INBOX", 19)
    );
    assert_eq!(header.message_id.as_deref(), Some("message@example.test"));
    assert_eq!(header.references, ["original@example.test"]);
    assert_eq!(header.receipt_to.as_deref(), Some("sender@example.test"));
    assert!(header.list_unsubscribe.unwrap().one_click);
    assert_eq!(header.raw_size, Some(720));
    assert_eq!(header.flags, ["\\Seen"]);
    assert!(parsed.flags_authoritative);
    assert_eq!(header.date_ts, Some(200));
    assert_eq!(parsed.internal_ts, Some(200));
    assert!(!header.body_cached);
    assert!(parsed.body_text.is_none());
}
