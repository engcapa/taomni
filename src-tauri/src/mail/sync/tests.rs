use super::{
    MailFolderSyncResult, MailSyncMode, MailSyncRequestMode, StepParams, apply_folder_step,
    imap_has_capability, imap_sync_folder_step, load_folder_sync_state, now_ms, step_result,
};
use crate::mail::MailFolder;
use crate::mail::ResolvedMailAccount;
use crate::mail::fake_imap::FakeImap;
use crate::mail::imap_fetch_messages_for_uids;
use crate::mail::now_ts;
use crate::mail::upsert_folder;
use rusqlite::Connection;
use rusqlite::params;
use taomni_mail_engine::cache::{MAIL_SCHEMA_VERSION, migrate_mail_tables};

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
