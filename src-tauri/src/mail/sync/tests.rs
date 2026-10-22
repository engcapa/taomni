use super::cache::apply_folder_step;
use super::cache::load_folder_sync_state;
use super::cache::now_ms;
use super::folder_step::imap_sync_folder_step;
use super::imap_protocol::imap_has_capability;
use super::imap_protocol::parse_examine_response;
use super::imap_protocol::quote_imap_string;
use super::model::MailFolderSyncResult;
use super::model::MailSyncMode;
use super::model::MailSyncRequestMode;
use super::model::StepParams;
use super::model::step_result;
use super::planning::plan_backfill;
use super::planning::plan_fill_range;
use super::planning::recent_window_start;
use super::schema::MAIL_SCHEMA_VERSION;
use super::schema::migrate_mail_tables;
use crate::mail::MailFolder;
use crate::mail::ResolvedMailAccount;
use crate::mail::imap_fetch_messages_for_uids;
use crate::mail::now_ts;
use crate::mail::upsert_folder;
use rusqlite::Connection;
use rusqlite::params;

#[test]
fn fill_plan_fetches_newest_missing_first_and_reports_vanished() {
    let server: Vec<u32> = (1..=10).chain(20..=25).collect();
    let cached = vec![1, 2, 3, 9, 10, 11, 25];
    let plan = plan_fill_range(&server, &cached, 1, None, 4);
    assert_eq!(plan.fetch, vec![21, 22, 23, 24]);
    assert_eq!(plan.remaining, 1 + 5); // 20 and 4..=8
    assert_eq!(plan.vanished, vec![11]);
    assert_eq!(plan.server_max, Some(25));
}

#[test]
fn fill_plan_clamps_open_range_and_star_semantics() {
    // `UID 51:*` on a server whose max UID is 50 returns 50.
    let plan = plan_fill_range(&[50], &[], 51, None, 10);
    assert!(plan.fetch.is_empty());
    assert_eq!(plan.server_max, None);
    let plan = plan_fill_range(&[1, 5, 9], &[1, 5, 9, 12], 5, Some(9), 10);
    assert!(plan.fetch.is_empty());
    assert!(plan.vanished.is_empty(), "12 is outside the range");
}

/// Simulates repeated catch-up steps after a long absence (R1): all new
/// UIDs end up cached regardless of the batch size.
#[test]
fn repeated_catchup_converges_without_gaps() {
    let mut cached: Vec<u32> = (1..=100).collect();
    let high = 100u32;
    let server: Vec<u32> = (1..=100).chain(101..=320).collect();
    let mut steps = 0;
    loop {
        let plan = plan_fill_range(&server, &cached, high + 1, None, 50);
        cached.extend(&plan.fetch);
        cached.sort_unstable();
        steps += 1;
        if plan.remaining == 0 {
            break;
        }
        // An interrupted step (nothing written) is recomputed next time.
        if steps == 2 {
            let again = plan_fill_range(&server, &cached, high + 1, None, 50);
            assert_eq!(again.remaining + again.fetch.len(), plan.remaining);
        }
    }
    assert_eq!(cached, server);
    assert_eq!(steps, 5);
}

#[test]
fn backfill_walks_down_and_completes() {
    let server: Vec<u32> = (1..=130).collect();
    let mut cached: Vec<u32> = (101..=130).collect();
    let mut low = 101u32;
    let mut complete = false;
    let mut rounds = 0;
    while !complete {
        let older: Vec<u32> = server.iter().copied().filter(|uid| *uid < low).collect();
        let plan = plan_backfill(&older, &cached, true, 40);
        cached.extend(&plan.fetch);
        low = plan.new_low.unwrap_or(low);
        complete = plan.complete;
        rounds += 1;
    }
    cached.sort_unstable();
    assert_eq!(cached, server);
    assert_eq!(low, 1);
    assert_eq!(rounds, 3);
    // An empty search below the span completes immediately.
    let plan = plan_backfill(&[], &cached, true, 40);
    assert!(plan.complete && plan.fetch.is_empty() && plan.new_low.is_none());
    // A window that did not reach UID 1 cannot complete.
    assert!(!plan_backfill(&[5, 6], &[], false, 40).complete);
}

#[test]
fn recent_window_start_uses_newest_cached_uids() {
    let cached: Vec<u32> = (1..=10).collect();
    assert_eq!(recent_window_start(&cached, 1, 3), 8);
    assert_eq!(recent_window_start(&cached, 1, 30), 1);
    assert_eq!(recent_window_start(&cached, 9, 3), 9);
}

#[test]
fn parses_condstore_examine_response() {
    let raw = "* FLAGS (\\Answered \\Flagged \\Seen $Junk)\r\n\
                   * OK [PERMANENTFLAGS ()] Read-only\r\n\
                   * 172 EXISTS\r\n\
                   * 0 RECENT\r\n\
                   * OK [UIDVALIDITY 3857529045] UIDs valid\r\n\
                   * OK [UIDNEXT 4392] Predicted next UID\r\n\
                   * OK [HIGHESTMODSEQ 715194045007] Highest\r\n\
                   A5 OK [READ-ONLY] EXAMINE completed\r\n";
    let parsed = parse_examine_response(raw);
    assert_eq!(parsed.exists, 172);
    assert_eq!(parsed.uid_validity, Some(3_857_529_045));
    assert_eq!(parsed.uid_next, Some(4392));
    assert_eq!(parsed.highest_modseq, Some(715_194_045_007));
    assert_eq!(
        parsed.flags,
        vec!["\\Answered", "\\Flagged", "\\Seen", "$Junk"]
    );
}

// -----------------------------------------------------------------
// End-to-end steps against the in-process fake IMAP server + SQLite.
// -----------------------------------------------------------------

#[test]
fn full_reconcile_handles_sparse_uids_under_server_command_limit() {
    let fake = FakeImap::start(false);
    fake.burn_uids("INBOX", 1_000_000_000);
    for _ in 0..1100 {
        fake.deliver("INBOX", 1, "sparse");
        fake.burn_uids("INBOX", 1);
    }
    let conn = db();
    let account = account(serde_json::json!({}));
    fake.state.lock().unwrap().max_command_bytes = Some(4096);
    drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 2000);
    drain(&fake, &conn, &account, MailSyncRequestMode::Backfill, 2000);
    let state = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
    let outcome = imap_sync_folder_step(
        &mut fake.session(),
        &account,
        "INBOX",
        &state,
        &StepParams {
            request: MailSyncRequestMode::ReconcileFull,
            limit: 200,
            include_bodies: false,
            condstore: false,
        },
    )
    .unwrap();
    assert_eq!(outcome.flag_updates.len(), 1100);
}

use super::super::fake_imap::FakeImap;
use super::super::{MailAccountConfig, init_mail_tables, upsert_message};

fn account(cache: serde_json::Value) -> ResolvedMailAccount {
    let config: MailAccountConfig = serde_json::from_value(serde_json::json!({
        "sessionId": "acct",
        "emailAddress": "user@example.com",
        "imap": { "host": "127.0.0.1", "port": 1, "security": "None" },
        "smtp": { "host": "127.0.0.1", "port": 1, "security": "None" },
        "cache": cache,
    }))
    .expect("config");
    ResolvedMailAccount {
        config,
        auth_mode: super::super::MailAuthMode::Password,
        network_settings: None,
        imap_username: "user".into(),
        imap_password: "pass".into(),
        smtp_username: "user".into(),
        smtp_password: "pass".into(),
    }
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    conn
}

fn step(
    fake: &FakeImap,
    conn: &Connection,
    account: &ResolvedMailAccount,
    request: MailSyncRequestMode,
    limit: usize,
) -> MailFolderSyncResult {
    let state = load_folder_sync_state(conn, "acct", "INBOX").unwrap();
    let mut session = fake.session();
    let condstore = imap_has_capability(&mut session, "CONDSTORE");
    let outcome = imap_sync_folder_step(
        &mut session,
        account,
        "INBOX",
        &state,
        &StepParams {
            request,
            limit,
            include_bodies: false,
            condstore,
        },
    )
    .expect("step");
    let applied =
        apply_folder_step(conn, "acct", &outcome, &account.config.cache, now_ms()).unwrap();
    step_result("acct", outcome, Some(applied))
}

/// Repeat a request until the backend reports no more work.
fn drain(
    fake: &FakeImap,
    conn: &Connection,
    account: &ResolvedMailAccount,
    request: MailSyncRequestMode,
    limit: usize,
) -> (usize, Vec<MailSyncMode>) {
    let mut new_unseen = 0;
    let mut modes = Vec::new();
    for _ in 0..200 {
        let result = step(fake, conn, account, request, limit);
        new_unseen += result.new_unseen;
        modes.push(result.mode);
        if !result.more {
            return (new_unseen, modes);
        }
    }
    panic!("sync did not converge: {modes:?}");
}

fn cached(conn: &Connection) -> Vec<u32> {
    load_folder_sync_state(conn, "acct", "INBOX")
        .unwrap()
        .cached_uids
}

fn cached_flags(conn: &Connection, uid: u32) -> Vec<String> {
    let json: String = conn
        .query_row(
            "SELECT flags_json FROM mail_messages WHERE folder = 'INBOX' AND uid = ?1",
            params![uid],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&json).unwrap()
}

/// AC-01/AC-02 (R1): more new mail than one batch after an absence is
/// fully fetched, and only genuinely new mail counts as new.
#[test]
fn catchup_after_absence_fetches_every_new_message() {
    for condstore in [false, true] {
        let fake = FakeImap::start(condstore);
        let conn = db();
        let account = account(serde_json::json!({}));
        fake.deliver("INBOX", 100, "old");
        let first = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        assert_eq!(first.mode, MailSyncMode::Initial);
        assert_eq!(first.new_unseen, 0, "initial sync is not new mail");
        assert_eq!(cached(&conn), (51..=100).collect::<Vec<_>>());

        // Tab closed; 120 arrive (and a few UIDs are burned elsewhere).
        fake.burn_uids("INBOX", 7);
        fake.deliver("INBOX", 120, "new");
        let (new_unseen, modes) = drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        assert_eq!(new_unseen, 120);
        assert!(modes.iter().all(|mode| *mode == MailSyncMode::Catchup));
        let server = fake.uids("INBOX");
        let expected: Vec<u32> = server.iter().copied().filter(|uid| *uid >= 51).collect();
        assert_eq!(cached(&conn), expected, "no gap after catch-up");

        // Nothing new: a further step is a no-op.
        let idle = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        assert_eq!((idle.fetched, idle.new_unseen, idle.more), (0, 0, false));
    }
}

/// TASK-18: List-Unsubscribe is parsed from the header fetch and cached.
#[test]
fn list_unsubscribe_is_cached_with_the_header() {
    let fake = FakeImap::start(false);
    let conn = db();
    let account = account(serde_json::json!({}));
    let raw = concat!(
        "From: News <news@example.com>\r\n",
        "To: user@example.com\r\n",
        "Subject: Weekly\r\n",
        "Date: Tue, 14 Nov 2023 22:13:20 +0000\r\n",
        "Message-ID: <weekly@example.com>\r\n",
        "List-Unsubscribe: <mailto:leave@example.com>, <https://example.com/u>\r\n",
        "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n",
        "Disposition-Notification-To: \"News\" <receipts@example.com>\r\n",
        "\r\nBody\r\n"
    );
    fake.deliver_raw("INBOX", raw.as_bytes().to_vec());
    fake.deliver("INBOX", 1, "plain");
    step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
    let rows = super::super::list_cached_messages(&conn, "acct", "INBOX", 10, 0).unwrap();
    let weekly = rows.iter().find(|row| row.subject == "Weekly").unwrap();
    let list = weekly.list_unsubscribe.clone().expect("list header cached");
    assert!(list.one_click);
    assert_eq!(
        list.uris,
        vec!["mailto:leave@example.com", "https://example.com/u"]
    );
    assert_eq!(weekly.receipt_to.as_deref(), Some("receipts@example.com"));
    let plain = rows.iter().find(|row| row.subject != "Weekly").unwrap();
    assert!(plain.list_unsubscribe.is_none());
    assert!(plain.receipt_to.is_none());
}

/// AC-07/AC-12: backfill walks older history down to UID 1.
#[test]
fn late_concurrent_backfill_does_not_regress_progress() {
    let fake = FakeImap::start(false);
    let conn = db();
    let account = account(serde_json::json!({}));
    fake.deliver("INBOX", 130, "msg");
    step(&fake, &conn, &account, MailSyncRequestMode::Auto, 40);
    let snapshot = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
    let delayed = imap_sync_folder_step(
        &mut fake.session(),
        &account,
        "INBOX",
        &snapshot,
        &StepParams {
            request: MailSyncRequestMode::Backfill,
            limit: 40,
            include_bodies: false,
            condstore: false,
        },
    )
    .unwrap();
    drain(&fake, &conn, &account, MailSyncRequestMode::Backfill, 40);
    apply_folder_step(&conn, "acct", &delayed, &account.config.cache, now_ms()).unwrap();
    let final_state = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
    assert_eq!(final_state.low, Some(1));
    assert!(final_state.complete);
    assert_eq!(final_state.cached_uids, fake.uids("INBOX"));
}

#[test]
fn backfill_reaches_the_oldest_message() {
    let fake = FakeImap::start(false);
    let conn = db();
    let account = account(serde_json::json!({}));
    fake.deliver("INBOX", 130, "msg");
    let first = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 40);
    assert!(!first.sync_complete);
    let (new_unseen, _) = drain(&fake, &conn, &account, MailSyncRequestMode::Backfill, 40);
    assert_eq!(new_unseen, 0, "history is not new mail");
    assert_eq!(cached(&conn), fake.uids("INBOX"));
    let folder = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
    assert!(folder.complete);
    assert_eq!(folder.low, Some(1));
}

/// AC-11: a cache written by the old newest-N logic has a hole; the first
/// sync after upgrade repairs it without reporting the hole as new mail.
#[test]
fn legacy_cache_gap_is_repaired() {
    let fake = FakeImap::start(false);
    let conn = db();
    let account = account(serde_json::json!({}));
    fake.deliver("INBOX", 140, "msg");
    // Old client cached 1..=40 and 91..=140 (41..=90 missing), no watermark.
    let mut session = fake.session();
    let legacy: Vec<u32> = (1..=40).chain(91..=140).collect();
    let messages =
        imap_fetch_messages_for_uids(&mut session, &account, "INBOX", &legacy, false).unwrap();
    upsert_folder(
        &conn,
        &MailFolder {
            account_id: "acct".into(),
            name: "INBOX".into(),
            uid_validity: Some(1000),
            ..MailFolder::default()
        },
    )
    .unwrap();
    for message in &messages {
        upsert_message(&conn, message).unwrap();
    }
    fake.deliver("INBOX", 20, "after-upgrade");
    let (new_unseen, modes) = drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 30);
    assert_eq!(modes.first(), Some(&MailSyncMode::Repair));
    assert!(modes.contains(&MailSyncMode::Catchup));
    assert_eq!(new_unseen, 20, "only mail after the old max is new");
    assert_eq!(cached(&conn), fake.uids("INBOX"));
}

/// A reconcile that read the server before a local flag change (tagging
/// while a background sync runs) must not undo that change; one that
/// started afterwards still applies another client's change.
#[test]
fn reconcile_does_not_undo_newer_local_flag_changes() {
    let fake = FakeImap::start(false);
    let conn = db();
    let account = account(serde_json::json!({}));
    let uids = fake.deliver("INBOX", 5, "msg");
    drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
    let target = uids[2];

    // The reconcile reads the server (no keyword yet) ...
    let state = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
    let started = now_ms();
    let mut session = fake.session();
    let outcome = imap_sync_folder_step(
        &mut session,
        &account,
        "INBOX",
        &state,
        &StepParams {
            request: MailSyncRequestMode::ReconcileFull,
            limit: 50,
            include_bodies: false,
            condstore: false,
        },
    )
    .expect("step");
    // ... then the user tags the message (cache + server) ...
    std::thread::sleep(std::time::Duration::from_millis(5));
    super::super::update_cached_flags(&conn, "acct", "INBOX", &[target], &["$label1".into()], &[])
        .unwrap();
    fake.set_flags("INBOX", target, &["$label1"]);
    // ... and the stale reconcile lands afterwards (it saw no keyword).
    let mut outcome = outcome;
    if !outcome.flag_updates.iter().any(|(uid, _)| *uid == target) {
        outcome.flag_updates.push((target, Vec::new()));
    }
    apply_folder_step(&conn, "acct", &outcome, &account.config.cache, started).unwrap();
    assert_eq!(cached_flags(&conn, target), vec!["$label1".to_string()]);

    // Another client clears it later: a fresh reconcile applies that.
    std::thread::sleep(std::time::Duration::from_millis(5));
    fake.set_flags("INBOX", target, &[]);
    step(
        &fake,
        &conn,
        &account,
        MailSyncRequestMode::ReconcileFull,
        50,
    );
    assert!(cached_flags(&conn, target).is_empty());
}

/// AC-04/AC-05 (R5/R6): server-side deletions and flag changes, including
/// a flag set becoming empty (unread), reach the cache.
#[test]
fn reconcile_applies_deletions_and_flag_changes() {
    for condstore in [false, true] {
        let fake = FakeImap::start(condstore);
        let conn = db();
        let account = account(serde_json::json!({}));
        let uids = fake.deliver("INBOX", 30, "msg");
        fake.set_flags("INBOX", uids[5], &["\\Seen"]);
        drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
        // Establish the modseq baseline.
        step(
            &fake,
            &conn,
            &account,
            MailSyncRequestMode::ReconcileFull,
            50,
        );
        assert_eq!(cached_flags(&conn, uids[5]), vec!["\\Seen".to_string()]);

        fake.expunge("INBOX", &uids[0..3]);
        fake.set_flags("INBOX", uids[5], &[]);
        fake.set_flags("INBOX", uids[6], &["\\Flagged"]);
        let result = step(
            &fake,
            &conn,
            &account,
            MailSyncRequestMode::ReconcileFull,
            50,
        );
        assert_eq!(result.vanished, 3);
        assert_eq!(result.flags_updated, 2, "condstore={condstore}");
        assert_eq!(cached(&conn), fake.uids("INBOX"));
        assert!(cached_flags(&conn, uids[5]).is_empty(), "now unread");
        assert_eq!(cached_flags(&conn, uids[6]), vec!["\\Flagged".to_string()]);

        // An unchanged mailbox reconciles without touching rows.
        let again = step(
            &fake,
            &conn,
            &account,
            MailSyncRequestMode::ReconcileFull,
            50,
        );
        assert_eq!((again.vanished, again.flags_updated), (0, 0));
        if condstore {
            let log = fake.log();
            assert!(log.iter().any(|line| line.contains("CHANGEDSINCE")));
        }
    }
}

/// AC-08: a UIDVALIDITY change rebuilds the folder.
#[test]
fn uid_validity_change_rebuilds_the_folder() {
    let fake = FakeImap::start(false);
    let conn = db();
    let account = account(serde_json::json!({}));
    fake.deliver("INBOX", 10, "msg");
    drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
    fake.reset_uid_validity("INBOX", 2000);
    let result = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
    assert!(result.uid_validity_reset);
    assert_eq!(result.mode, MailSyncMode::Initial);
    assert_eq!(cached(&conn), fake.uids("INBOX"));
    let state = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
    assert_eq!(state.uid_validity, Some(2000));
}

/// AC-06 (R3): retention uses the arrival time, so a new message with an
/// old `Date:` header survives; truly old mail is pruned and the span stays
/// consistent (no refetch loop).
#[test]
fn retention_uses_arrival_time_and_keeps_span_consistent() {
    let fake = FakeImap::start(false);
    let conn = db();
    let account = account(serde_json::json!({ "headerRetentionDays": 30 }));
    let now = now_ts();
    let old = fake.deliver_dated(
        "INBOX",
        5,
        "old",
        now - 90 * 86_400,
        "Mon, 1 Jan 2018 00:00:00 +0000",
    );
    let backdated = fake.deliver_dated(
        "INBOX",
        1,
        "backdated",
        now,
        "Mon, 1 Jan 2018 00:00:00 +0000",
    );
    drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
    assert_eq!(
        cached(&conn),
        backdated,
        "old arrivals pruned, back-dated arrival kept"
    );
    let state = load_folder_sync_state(&conn, "acct", "INBOX").unwrap();
    assert!(state.complete, "retention boundary ends backfill");
    assert!(state.low.unwrap() > *old.last().unwrap());
    let again = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 50);
    assert_eq!(again.fetched, 0, "pruned history is not refetched");
}

/// A per-folder header cap converges instead of refetching pruned rows.
#[test]
fn header_limit_converges() {
    let fake = FakeImap::start(false);
    let conn = db();
    let account = account(serde_json::json!({ "headerLimitPerFolder": 25 }));
    fake.deliver("INBOX", 10, "a");
    drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 10);
    fake.deliver("INBOX", 100, "b");
    drain(&fake, &conn, &account, MailSyncRequestMode::Auto, 10);
    let server = fake.uids("INBOX");
    assert_eq!(cached(&conn), server[server.len() - 25..].to_vec());
    let again = step(&fake, &conn, &account, MailSyncRequestMode::Auto, 10);
    assert_eq!(again.fetched, 0);
}

#[test]
fn migration_is_idempotent_and_keeps_rows() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    conn.execute_batch("PRAGMA user_version = 0;").unwrap();
    migrate_mail_tables(&conn).unwrap();
    migrate_mail_tables(&conn).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, MAIL_SCHEMA_VERSION);
}

#[test]
fn quotes_mailbox_names() {
    assert_eq!(quote_imap_string("INBOX"), "\"INBOX\"");
    assert_eq!(quote_imap_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
    assert_eq!(quote_imap_string("x\r\ny"), "\"xy\"");
}
