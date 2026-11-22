use taomni_mail_engine::filters::imap::imap_body_hits;

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
