use super::*;
#[test]
fn decode_imap_modified_utf7_mailbox_names() {
    assert_eq!(decode_imap_modified_utf7("INBOX"), "INBOX");
    assert_eq!(decode_imap_modified_utf7("A &- B"), "A & B");
    assert_eq!(
        decode_imap_modified_utf7("~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
        "~peter/mail/台北/日本語"
    );
}

#[test]
fn imap_login_retry_classifies_transient_and_auth_errors() {
    assert!(should_retry_imap_login("No Response: LOGIN Login error"));
    assert!(should_retry_imap_login(
        "temporary rate limit, try again later"
    ));
    assert!(!should_retry_imap_login(
        "NO [AUTHENTICATIONFAILED] Invalid credentials"
    ));
    assert!(!should_retry_imap_login(
        "NO invalid login or password incorrect"
    ));
}

#[test]
fn parse_body_decodes_headers_and_preview() {
    let parsed = parse_body_message("acct", "INBOX", 7, Some(512), &sample_message(), 4096);
    assert_eq!(parsed.header.subject, "测试邮件");
    assert_eq!(
        parsed.header.message_id.as_deref(),
        Some("sample@example.com")
    );
    assert_eq!(
        parsed
            .header
            .from
            .as_ref()
            .and_then(|a| a.address.as_deref()),
        Some("sender@example.com")
    );
    assert_eq!(
        parsed.header.snippet.as_deref(),
        Some("Hello from Taomni Mail.")
    );
    assert!(parsed.body_text.as_deref().unwrap().contains("Taomni Mail"));
}

#[test]
fn parse_and_extract_attachment() {
    let raw = sample_attachment_message();
    let parsed = parse_body_message("acct", "INBOX", 8, Some(raw.len() as u32), &raw, 4096);
    assert!(parsed.header.has_attachments);
    assert_eq!(parsed.header.attachment_count, 1);
    assert_eq!(
        parsed.header.attachments[0].name.as_deref(),
        Some("report.txt")
    );

    let attachment = extract_attachment(&raw, 0).unwrap();
    assert_eq!(attachment.name.as_deref(), Some("report.txt"));
    assert_eq!(attachment.content_type.as_deref(), Some("text/plain"));
    assert_eq!(attachment.bytes, b"Attachment content.");
}

#[test]
fn parse_body_rewrites_cid_images_to_data_urls() {
    let raw = sample_inline_image_message();
    let parsed = parse_body_message("acct", "INBOX", 9, Some(raw.len() as u32), &raw, 4096);
    let html = parsed.body_html.as_deref().expect("html body");
    assert!(
        html.contains("data:image/png;base64,"),
        "expected embedded data URL, got: {html}"
    );
    assert!(
        !html.to_ascii_lowercase().contains("cid:logo@inline.local"),
        "cid reference should be rewritten for display"
    );
    assert!(html.contains("alt=\"logo\""));
}

#[test]
fn saved_mime_attachment_sections_handle_nested_parts_and_embedded_messages() {
    let raw = b"Content-Type: multipart/mixed; boundary=a\r\n\r\n--a\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nplain\r\n--b\r\nContent-Type: text/html\r\n\r\n<b>html</b>\r\n--b--\r\n--a\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=payload.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--a\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename=inner.eml\r\n\r\nSubject: Inner\r\nContent-Type: text/plain\r\n\r\nembedded\r\n--a--\r\n";
    assert_eq!(
        extract_attachment_section(raw, "1.2").unwrap().bytes,
        b"<b>html</b>"
    );
    let binary = extract_attachment_section(raw, "2").unwrap();
    assert_eq!(binary.name.as_deref(), Some("payload.bin"));
    assert_eq!(binary.bytes, [0, 1, 2, 3]);
    assert!(
        extract_attachment_section(raw, "3")
            .unwrap()
            .bytes
            .starts_with(b"Subject: Inner")
    );
    assert_eq!(
        extract_attachment_section(raw, "3.1").unwrap().bytes,
        b"embedded"
    );
    for invalid in ["0", "4", "1", "1.1.1", "2.1", "1.MIME", ""] {
        assert!(
            extract_attachment_section(raw, invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn cache_roundtrips_folders_messages_and_body() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let mut message = parse_body_message("acct", "INBOX", 10, Some(512), &sample_message(), 4096);
    message.header.flags = vec!["\\Seen".into()];
    let folder = MailFolder {
        account_id: "acct".into(),
        name: "INBOX".into(),
        display_name: "INBOX".into(),
        delimiter: Some("/".into()),
        flags: vec![],
        uid_validity: Some(1),
        uid_next: Some(11),
        total: Some(1),
        unread: Some(0),
        updated_at: now_ts(),
        ..MailFolder::default()
    };
    cache_sync_result(
        &conn,
        "acct",
        &[folder],
        &[message],
        "INBOX",
        &MailCacheSettings {
            header_retention_days: 0,
            ..MailCacheSettings::default()
        },
    )
    .unwrap();

    let folders = list_cached_folders(&conn, "acct").unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].uid_next, Some(11));

    let messages = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].subject, "测试邮件");
    assert!(messages[0].body_cached);

    let body = get_cached_body(&conn, "acct", "INBOX", 10)
        .unwrap()
        .unwrap();
    assert_eq!(body.source, "cache");
    assert!(body.text.unwrap().contains("Taomni Mail"));
}

#[test]
fn contact_index_searches_cached_headers() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let message = parse_body_message("acct", "INBOX", 10, Some(512), &sample_message(), 4096);
    upsert_message(&conn, &message).unwrap();

    assert_eq!(reindex_cached_contacts(&conn, "acct").unwrap(), 2);
    let contacts = search_contacts(&conn, "acct", "sender", 8).unwrap();

    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0].email, "sender@example.com");
    assert_eq!(contacts[0].source, "history");
}

#[test]
fn smtp_size_rejections_get_a_hint() {
    assert!(
        smtp_send_error("permanent error (552): 5.3.4 Message size exceeds fixed limit")
            .contains("SIZE limit")
    );
    assert_eq!(
        smtp_send_error("permanent error (550): no such user"),
        "SMTP send failed: permanent error (550): no such user"
    );
}

#[test]
fn sent_contacts_raise_sent_source() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let request = MailSendRequest {
        in_reply_to: None,
        references: Vec::new(),
        draft_id: None,
        from: None,
        reply_to: None,
        to: vec!["Receiver <receiver@example.com>".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hello".into(),
        text_body: Some("Body".into()),
        html_body: None,
        attachments: vec![],
        request_read_receipt: false,
    };

    assert_eq!(upsert_sent_contacts(&conn, "acct", &request).unwrap(), 1);
    let contacts = search_contacts(&conn, "acct", "receiver", 8).unwrap();

    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0].name.as_deref(), Some("Receiver"));
    assert_eq!(contacts[0].source, "sent");
}
