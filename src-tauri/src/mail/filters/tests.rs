use super::cache::CandidateSelection;
use super::cache::ensure_filter_mark;
use super::cache::filter_mark;
use super::cache::load_candidates;
use super::cache::load_filters;
use super::cache::store_filters;
use super::commands::parse_filter_file;
use super::execution::prepare_filters;
use super::imap_search::imap_body_hits;
use super::matching::condition_matches;
use super::model::FILTER_FILE_FORMAT;
use super::model::FilterFile;
use super::model::FilterMessage;
use super::model::MailFilter;
use super::model::MailFilterAction;
use super::model::MailFilterActionKind;
use super::model::MailFilterCondition;
use super::model::MailFilterField;
use super::model::MailFilterOp;
use super::planning::MessagePlan;
use super::planning::plan_message;
use super::planning::validate_filter;
use crate::mail::MailMessageHeader;
use rusqlite::Connection;
use rusqlite::params;
use std::collections::HashSet;

use crate::mail::MailAddress;

fn header(uid: u32, from: &str, subject: &str) -> MailMessageHeader {
    MailMessageHeader {
        account_id: "acct".into(),
        folder: "INBOX".into(),
        uid,
        message_id: None,
        subject: subject.into(),
        from: Some(MailAddress {
            name: Some("Boss".into()),
            address: Some(from.into()),
        }),
        to: vec![MailAddress {
            name: None,
            address: Some("me@example.com".into()),
        }],
        cc: Vec::new(),
        date_ts: Some(1_700_000_000),
        flags: Vec::new(),
        has_attachments: false,
        attachment_count: 0,
        attachments: Vec::new(),
        snippet: None,
        raw_size: Some(4096),
        body_cached: false,
        in_reply_to: None,
        references: Vec::new(),
        list_unsubscribe: None,
        receipt_to: None,
    }
}

fn cond(field: MailFilterField, op: MailFilterOp, value: &str) -> MailFilterCondition {
    MailFilterCondition {
        field,
        op,
        value: value.into(),
    }
}

fn action(kind: MailFilterActionKind, value: Option<&str>) -> MailFilterAction {
    MailFilterAction {
        kind,
        value: value.map(str::to_string),
    }
}

fn filter(
    name: &str,
    conditions: Vec<MailFilterCondition>,
    actions: Vec<MailFilterAction>,
) -> MailFilter {
    MailFilter {
        id: name.into(),
        name: name.into(),
        enabled: true,
        match_any: false,
        conditions,
        actions,
        on_incoming: true,
    }
}

fn message<'a>(header: &'a MailMessageHeader, body: Option<&'a str>) -> FilterMessage<'a> {
    FilterMessage {
        header,
        body,
        server_body: None,
        now: 1_700_000_000 + 10 * 86_400,
    }
}

#[test]
fn conditions_cover_fields_and_operators() {
    let h = header(1, "boss@example.com", "Weekly Report 42");
    let m = message(&h, Some("Please find the numbers attached"));
    let yes = [
        cond(MailFilterField::From, MailFilterOp::Is, "BOSS@example.com"),
        cond(
            MailFilterField::From,
            MailFilterOp::EndsWith,
            "@example.com",
        ),
        cond(MailFilterField::From, MailFilterOp::Contains, "boss"),
        cond(MailFilterField::ToOrCc, MailFilterOp::Is, "me@example.com"),
        cond(MailFilterField::Subject, MailFilterOp::BeginsWith, "weekly"),
        cond(
            MailFilterField::Subject,
            MailFilterOp::Matches,
            r"report \d+$",
        ),
        cond(MailFilterField::Body, MailFilterOp::Contains, "NUMBERS"),
        cond(MailFilterField::SizeKb, MailFilterOp::GreaterThan, "3"),
        cond(MailFilterField::AgeDays, MailFilterOp::GreaterThan, "7"),
        cond(MailFilterField::Tag, MailFilterOp::IsNot, "$label1"),
        cond(MailFilterField::HasAttachment, MailFilterOp::Is, "false"),
    ];
    for c in &yes {
        assert!(condition_matches(c, &m), "{c:?}");
    }
    let no = [
        cond(
            MailFilterField::From,
            MailFilterOp::IsNot,
            "boss@example.com",
        ),
        cond(
            MailFilterField::Subject,
            MailFilterOp::NotContains,
            "report",
        ),
        cond(MailFilterField::SizeKb, MailFilterOp::LessThan, "2"),
        cond(MailFilterField::Cc, MailFilterOp::Contains, "me@"),
        cond(MailFilterField::Subject, MailFilterOp::Matches, "("),
    ];
    for c in &no {
        assert!(!condition_matches(c, &m), "{c:?}");
    }
}

#[test]
fn uncached_bodies_use_server_hits() {
    let h = header(1, "a@example.com", "x");
    let hits: HashSet<String> = ["invoice".to_string()].into_iter().collect();
    let m = FilterMessage {
        header: &h,
        body: None,
        server_body: Some(&hits),
        now: 0,
    };
    let body = |op, value| cond(MailFilterField::Body, op, value);
    assert!(condition_matches(
        &body(MailFilterOp::Contains, "Invoice"),
        &m
    ));
    assert!(!condition_matches(
        &body(MailFilterOp::NotContains, "invoice"),
        &m
    ));
    assert!(condition_matches(
        &body(MailFilterOp::NotContains, "refund"),
        &m
    ));
    assert!(!condition_matches(&body(MailFilterOp::Is, "invoice"), &m));
}

#[test]
fn plans_follow_thunderbird_semantics() {
    let h = header(1, "boss@example.com", "Weekly report");
    let m = message(&h, None);
    let from_boss = || vec![cond(MailFilterField::From, MailFilterOp::Contains, "boss")];
    let tag = filter(
        "tag",
        from_boss(),
        vec![
            action(MailFilterActionKind::AddTag, Some("$label1")),
            action(MailFilterActionKind::MarkRead, None),
        ],
    );
    let mut any = filter(
        "any",
        vec![
            cond(MailFilterField::Subject, MailFilterOp::Contains, "nope"),
            cond(MailFilterField::Subject, MailFilterOp::Contains, "weekly"),
        ],
        vec![action(MailFilterActionKind::MoveTo, Some("Reports"))],
    );
    any.match_any = true;
    let after = filter(
        "after",
        from_boss(),
        vec![action(MailFilterActionKind::Star, None)],
    );
    let plan = plan_message(&[&tag, &any, &after], &m);
    assert_eq!(plan.matched, vec!["tag", "any"]);
    assert_eq!(plan.tags, vec!["$label1"]);
    assert!(plan.mark_read);
    assert_eq!(plan.move_to.as_deref(), Some("Reports"));
    assert!(!plan.star, "a move ends the chain");

    let stop = filter(
        "stop",
        from_boss(),
        vec![action(MailFilterActionKind::Stop, None)],
    );
    let mut disabled = after.clone();
    disabled.enabled = false;
    assert_eq!(plan_message(&[&disabled], &m), MessagePlan::default());
    assert_eq!(plan_message(&[&stop, &after], &m).matched, vec!["stop"]);
    let same_folder = filter(
        "noop",
        from_boss(),
        vec![
            action(MailFilterActionKind::MoveTo, Some("INBOX")),
            action(MailFilterActionKind::Star, None),
        ],
    );
    let plan = plan_message(&[&same_folder], &m);
    assert!(plan.move_to.is_none() && plan.star);
}

#[test]
fn validation_rejects_incomplete_rules() {
    let ok = filter(
        "ok",
        vec![cond(MailFilterField::From, MailFilterOp::Contains, "a")],
        vec![action(MailFilterActionKind::MoveTo, Some("Archive"))],
    );
    assert!(validate_filter(&ok).is_ok());
    let mut bad = ok.clone();
    bad.name = " ".into();
    assert!(validate_filter(&bad).is_err());
    let mut bad = ok.clone();
    bad.actions = vec![action(MailFilterActionKind::MoveTo, None)];
    assert!(validate_filter(&bad).is_err());
    let mut bad = ok.clone();
    bad.conditions = vec![cond(
        MailFilterField::SizeKb,
        MailFilterOp::GreaterThan,
        "big",
    )];
    assert!(validate_filter(&bad).is_err());
    let mut bad = ok.clone();
    bad.conditions = vec![cond(MailFilterField::Subject, MailFilterOp::Matches, "(")];
    assert!(
        validate_filter(&bad)
            .unwrap_err()
            .contains("regular expression")
    );
    let mut bad = ok;
    bad.actions = vec![action(MailFilterActionKind::Forward, Some("nobody"))];
    assert!(validate_filter(&bad).is_err());
}

#[test]
fn storage_marks_and_files() {
    let conn = Connection::open_in_memory().unwrap();
    crate::mail::init_mail_tables(&conn).unwrap();
    let f = filter(
        "a",
        vec![cond(MailFilterField::From, MailFilterOp::Contains, "a")],
        vec![action(MailFilterActionKind::Star, None)],
    );
    let prepared = prepare_filters(vec![f.clone(), f]).unwrap();
    assert_ne!(prepared[0].id, prepared[1].id, "duplicate ids are replaced");
    store_filters(&conn, "acct", &prepared).unwrap();
    assert_eq!(load_filters(&conn, "acct").unwrap(), prepared);
    assert!(load_filters(&conn, "other").unwrap().is_empty());

    conn.execute(
        "INSERT INTO mail_folders (account_id, name, uid_validity, updated_at)
             VALUES ('acct', 'INBOX', 7, 0)",
        [],
    )
    .unwrap();
    let insert = |uid: u32| {
        conn.execute(
            "INSERT INTO mail_messages (account_id, folder, uid, updated_at)
                 VALUES ('acct', 'INBOX', ?1, 0)",
            params![uid],
        )
        .unwrap();
    };
    insert(3);
    insert(9);
    assert_eq!(filter_mark(&conn, "acct", "INBOX").unwrap(), None);
    ensure_filter_mark(&conn, "acct", "INBOX").unwrap();
    assert_eq!(filter_mark(&conn, "acct", "INBOX").unwrap(), Some(9));
    insert(12);
    let fresh = load_candidates(&conn, "acct", "INBOX", &CandidateSelection::Above(9)).unwrap();
    assert_eq!(
        fresh.iter().map(|(h, _)| h.uid).collect::<Vec<_>>(),
        vec![12]
    );
    let picked = load_candidates(
        &conn,
        "acct",
        "INBOX",
        &CandidateSelection::Uids(vec![3, 12]),
    )
    .unwrap();
    assert_eq!(picked.len(), 2);
    // A UIDVALIDITY change invalidates the mark.
    conn.execute("UPDATE mail_folders SET uid_validity = 8", [])
        .unwrap();
    assert_eq!(filter_mark(&conn, "acct", "INBOX").unwrap(), None);

    let file = serde_json::to_string(&FilterFile {
        format: FILTER_FILE_FORMAT.into(),
        version: 1,
        filters: prepared.clone(),
    })
    .unwrap();
    assert_eq!(parse_filter_file(&file).unwrap(), prepared);
    let bare = serde_json::to_string(&prepared).unwrap();
    assert_eq!(parse_filter_file(&bare).unwrap(), prepared);
    assert!(parse_filter_file(r#"{"format":"x","version":1,"filters":[]}"#).is_err());
}

#[test]
fn server_body_search_is_limited_to_the_candidates() {
    let fake = super::super::fake_imap::FakeImap::start(false);
    let message =
        |body: &str| format!("From: a@example.com\r\nSubject: s\r\n\r\n{body}\r\n").into_bytes();
    let invoice = fake.deliver_raw("INBOX", message("Your INVOICE is ready"));
    let other = fake.deliver_raw("INBOX", message("nothing here"));
    let outside = fake.deliver_raw("INBOX", message("another invoice"));
    let mut session = fake.session();
    let hits = imap_body_hits(
        &mut session,
        "INBOX",
        &[invoice, other],
        &["invoice".to_string(), "refund".to_string()],
    )
    .unwrap();
    assert_eq!(
        hits.get(&invoice).map(|set| set.contains("invoice")),
        Some(true)
    );
    assert!(!hits.contains_key(&other));
    assert!(
        !hits.contains_key(&outside),
        "only the requested UIDs are searched"
    );
}
