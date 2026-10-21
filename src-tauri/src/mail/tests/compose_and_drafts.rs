use super::*;
#[test]
fn build_send_message_threads_replies_and_keeps_bcc_for_copies() {
    let request = MailSendRequest {
        to: vec!["Receiver <receiver@example.com>".into()],
        cc: vec![],
        bcc: vec!["hidden@example.com".into()],
        subject: "Re: Plan".into(),
        text_body: Some("Reply".into()),
        html_body: None,
        attachments: vec![],
        in_reply_to: Some("parent@example.com".into()),
        references: vec!["<root@example.com>".into(), "parent@example.com".into()],
        draft_id: None,
        from: None,
        reply_to: None,
        request_read_receipt: false,
    };
    let account = sample_resolved_account();
    let raw =
        String::from_utf8(build_send_message(&account, &request).unwrap().formatted()).unwrap();
    assert!(raw.contains("In-Reply-To: <parent@example.com>"), "{raw}");
    assert!(
        raw.contains("References: <root@example.com> <parent@example.com>"),
        "{raw}"
    );
    assert!(
        !raw.contains("hidden@example.com"),
        "SMTP message omits Bcc"
    );
    assert!(!raw.contains("Disposition-Notification-To"), "{raw}");
    let receipt = MailSendRequest {
        request_read_receipt: true,
        ..request.clone()
    };
    let raw =
        String::from_utf8(build_send_message(&account, &receipt).unwrap().formatted()).unwrap();
    assert!(
        raw.contains("Disposition-Notification-To: <sender@example.com>"),
        "{raw}"
    );

    let copy = build_send_message_with(
        &account,
        &request,
        &MessageBuildOptions {
            message_id: Some("<fixed@example.com>".into()),
            keep_bcc: true,
            self_envelope: false,
        },
    )
    .unwrap();
    let raw = String::from_utf8(copy.formatted()).unwrap();
    assert!(raw.contains("hidden@example.com"), "Sent copy keeps Bcc");
    assert!(raw.contains("Message-ID: <fixed@example.com>"), "{raw}");
}

#[test]
fn identity_overrides_from_and_reply_to() {
    let request = MailSendRequest {
        to: vec!["receiver@example.com".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hi".into(),
        text_body: Some("Body".into()),
        html_body: None,
        attachments: vec![],
        in_reply_to: None,
        references: vec![],
        draft_id: None,
        from: Some("Support <support@example.com>".into()),
        reply_to: Some("help@example.com".into()),
        request_read_receipt: false,
    };
    let message = build_send_message(&sample_resolved_account(), &request).unwrap();
    let raw = String::from_utf8(message.formatted()).unwrap();
    assert!(raw.contains("From: Support <support@example.com>"), "{raw}");
    assert!(raw.contains("Reply-To: help@example.com"), "{raw}");
    assert_eq!(
        message.envelope().from().unwrap().to_string(),
        "support@example.com"
    );
}

#[test]
fn draft_envelope_allows_messages_without_recipients() {
    let request = MailSendRequest {
        to: vec![],
        cc: vec![],
        bcc: vec![],
        subject: String::new(),
        text_body: Some("half written".into()),
        html_body: None,
        attachments: vec![],
        in_reply_to: None,
        references: vec![],
        draft_id: None,
        from: None,
        reply_to: None,
        request_read_receipt: false,
    };
    let options = MessageBuildOptions {
        self_envelope: true,
        ..MessageBuildOptions::default()
    };
    let raw = build_send_message_with(&sample_resolved_account(), &request, &options)
        .unwrap()
        .formatted();
    assert!(String::from_utf8(raw).unwrap().contains("half written"));
}

#[test]
fn parses_thread_headers_from_fetched_headers() {
    let raw = b"Subject: Re: x
Message-ID: <c@x>
In-Reply-To: <b@x>
References: <a@x>
 <b@x>

";
    let parsed = MessageParser::default().parse(&raw[..]).unwrap();
    assert_eq!(
        header_message_ids(parsed.in_reply_to()),
        vec!["b@x".to_string()]
    );
    assert_eq!(
        header_message_ids(parsed.references()),
        vec!["a@x".to_string(), "b@x".to_string()]
    );
}

#[test]
fn build_send_message_wraps_attachments_in_mixed_mime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("report.txt");
    std::fs::write(&path, b"attachment body").unwrap();
    let request = MailSendRequest {
        to: vec!["Receiver <receiver@example.com>".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hello".into(),
        text_body: Some("Plain body".into()),
        html_body: Some("<p><strong>HTML body</strong></p>".into()),
        in_reply_to: None,
        references: Vec::new(),
        draft_id: None,
        from: None,
        reply_to: None,
        attachments: vec![MailSendAttachment {
            path: path.to_string_lossy().into_owned(),
            name: Some("report.txt".into()),
            content_type: Some("text/plain".into()),
            inline: false,
            content_id: None,
        }],
        request_read_receipt: false,
    };

    let message = build_send_message(&sample_resolved_account(), &request).unwrap();
    let raw = String::from_utf8(message.formatted()).unwrap();

    assert!(raw.contains("multipart/mixed"));
    assert!(raw.contains("multipart/alternative"));
    assert!(raw.contains("filename=\"report.txt\""));
}

#[test]
fn build_send_message_embeds_inline_images_in_related_mime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("logo.png");
    std::fs::write(&path, b"png body").unwrap();
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
        text_body: Some("Plain body".into()),
        html_body: Some("<p><img src=\"cid:logo-1@inline.local\"></p>".into()),
        attachments: vec![MailSendAttachment {
            path: path.to_string_lossy().into_owned(),
            name: Some("logo.png".into()),
            content_type: Some("image/png".into()),
            inline: true,
            content_id: Some("logo-1@inline.local".into()),
        }],
        request_read_receipt: false,
    };

    let message = build_send_message(&sample_resolved_account(), &request).unwrap();
    let raw = String::from_utf8(message.formatted()).unwrap();

    assert!(raw.contains("multipart/related"));
    assert!(raw.contains("multipart/alternative"));
    assert!(raw.contains("Content-ID: <logo-1@inline.local>"));
    assert!(raw.contains("Content-Disposition: inline; filename=\"logo.png\""));
}

#[test]
fn build_send_message_nests_related_body_inside_mixed() {
    let dir = tempfile::tempdir().unwrap();
    let image_path = dir.path().join("logo.png");
    let report_path = dir.path().join("report.txt");
    std::fs::write(&image_path, b"png body").unwrap();
    std::fs::write(&report_path, b"report body").unwrap();
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
        text_body: Some("Plain body".into()),
        html_body: Some("<p><img src=\"cid:logo-1@inline.local\"></p>".into()),
        attachments: vec![
            MailSendAttachment {
                path: image_path.to_string_lossy().into_owned(),
                name: Some("logo.png".into()),
                content_type: Some("image/png".into()),
                inline: true,
                content_id: Some("logo-1@inline.local".into()),
            },
            MailSendAttachment {
                path: report_path.to_string_lossy().into_owned(),
                name: Some("report.txt".into()),
                content_type: Some("text/plain".into()),
                inline: false,
                content_id: None,
            },
        ],
        request_read_receipt: false,
    };

    let message = build_send_message(&sample_resolved_account(), &request).unwrap();
    let raw = String::from_utf8(message.formatted()).unwrap();

    assert!(raw.contains("multipart/mixed"));
    assert!(raw.contains("multipart/related"));
    assert!(raw.contains("Content-ID: <logo-1@inline.local>"));
    assert!(raw.contains("filename=\"report.txt\""));
}

#[test]
fn local_drafts_roundtrip_and_delete() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let saved = save_mail_draft(
        &conn,
        "acct",
        MailDraftSaveRequest {
            id: None,
            to: vec!["Receiver <receiver@example.com>".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Draft subject".into(),
            text_body: "Plain".into(),
            html_body: "<p>Plain</p>".into(),
            attachments: vec![MailDraftAttachment {
                path: "/tmp/report.txt".into(),
                name: Some("report.txt".into()),
                content_type: Some("text/plain".into()),
                inline: false,
                content_id: None,
                size: Some(12),
                modified_at: Some(123),
            }],
            reply_context: Some(MailDraftContext {
                kind: Some("reply".into()),
                folder: Some("INBOX".into()),
                uid: Some(42),
                message_id: Some("msg@example.com".into()),
                subject: Some("Original".into()),
                references: Vec::new(),
                identity_id: None,
                outbox: None,
            }),
            remote_draft_folder: None,
            remote_draft_uid: None,
        },
    )
    .unwrap();

    let drafts = list_mail_drafts(&conn, "acct").unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].id, saved.id);
    assert_eq!(drafts[0].attachments[0].name.as_deref(), Some("report.txt"));
    assert_eq!(
        drafts[0].reply_context.as_ref().and_then(|ctx| ctx.uid),
        Some(42)
    );

    delete_mail_draft(&conn, "acct", &saved.id).unwrap();
    assert!(list_mail_drafts(&conn, "acct").unwrap().is_empty());
}

#[test]
fn update_and_remove_cache_helpers_mutate_rows() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let mut first = parse_body_message("acct", "INBOX", 1, Some(10), &sample_message(), 4096);
    first.header.flags = vec!["\\Seen".into()];
    let mut second = parse_body_message("acct", "INBOX", 2, Some(10), &sample_message(), 4096);
    second.header.flags = vec!["\\Seen".into()];
    upsert_message(&conn, &first).unwrap();
    upsert_message(&conn, &second).unwrap();

    update_cached_flags(
        &conn,
        "acct",
        "INBOX",
        &[1],
        &["\\Flagged".into()],
        &["\\Seen".into()],
    )
    .unwrap();
    let messages = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
    let one = messages.iter().find(|m| m.uid == 1).unwrap();
    assert!(
        one.flags
            .iter()
            .any(|f| f.eq_ignore_ascii_case("\\Flagged"))
    );
    assert!(!one.flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")));
    let two = messages.iter().find(|m| m.uid == 2).unwrap();
    assert!(two.flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")));

    remove_cached_messages(&conn, "acct", "INBOX", &[1]).unwrap();
    let after = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].uid, 2);
}

#[test]
fn purge_cached_folder_removes_folder_and_subfolders_only() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    for name in ["Parent", "Parent/Child", "ParentX"] {
        upsert_message(
            &conn,
            &parse_body_message("acct", name, 1, Some(10), &sample_message(), 4096),
        )
        .unwrap();
        upsert_folder(
            &conn,
            &MailFolder {
                account_id: "acct".into(),
                name: name.into(),
                display_name: name.into(),
                delimiter: Some("/".into()),
                flags: vec![],
                uid_validity: None,
                uid_next: None,
                total: None,
                unread: None,
                updated_at: now_ts(),
                ..MailFolder::default()
            },
        )
        .unwrap();
    }

    purge_cached_folder(&conn, "acct", "Parent").unwrap();

    let names = list_cached_folders(&conn, "acct")
        .unwrap()
        .into_iter()
        .map(|f| f.name)
        .collect::<Vec<_>>();
    assert!(names.contains(&"ParentX".to_string()));
    assert!(!names.contains(&"Parent".to_string()));
    assert!(!names.contains(&"Parent/Child".to_string()));
    assert_eq!(
        list_cached_messages(&conn, "acct", "Parent", 20, 0)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        list_cached_messages(&conn, "acct", "Parent/Child", 20, 0)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        list_cached_messages(&conn, "acct", "ParentX", 20, 0)
            .unwrap()
            .len(),
        1
    );
}
