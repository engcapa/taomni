//! Real SQLite and loopback IMAP checks; all data is disposable.
use super::*;
use std::sync::mpsc;

#[test]
fn delayed_body_and_header_fetches_preserve_newer_local_flags() {
    let db = Connection::open_in_memory().unwrap();
    init_mail_tables(&db).unwrap();
    let mut message = empty_cached_message("qa", "INBOX", 1);
    message.flags_authoritative = true;
    upsert_message(&db, &message).unwrap();
    let started = sync::now_ms() - 1;
    mark_cached_messages_read(&db, "qa", "INBOX", &[1]).unwrap();
    message.body_text = Some("body fetched before STORE completed".into());
    upsert_message_at(&db, &message, Some(started)).unwrap();
    cache_synced_messages(&db, &[message.clone()], started).unwrap();
    let header = cached_header(&db, "qa", "INBOX", 1).unwrap().unwrap();
    assert!(header.flags.iter().any(|flag| flag == "\\Seen"));
    let body: String = db
        .query_row("SELECT body_text FROM mail_messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(body, "body fetched before STORE completed");
    // A later server observation can still report an externally unread message.
    upsert_message_at(&db, &message, Some(sync::now_ms() + 1)).unwrap();
    assert!(
        cached_header(&db, "qa", "INBOX", 1)
            .unwrap()
            .unwrap()
            .flags
            .is_empty()
    );
}

fn account(port: u16) -> ResolvedMailAccount {
    ResolvedMailAccount {
        config: serde_json::from_value(serde_json::json!({
            "sessionId": "qa-responsiveness",
            "emailAddress": "user@example.test",
            "imap": { "host": "127.0.0.1", "port": port, "security": "none" },
            "smtp": { "host": "127.0.0.1", "port": 1, "security": "none" },
        }))
        .unwrap(),
        auth_mode: MailAuthMode::Password,
        imap_username: "user".into(),
        imap_password: "pass".into(),
        smtp_username: "user".into(),
        smtp_password: "pass".into(),
        network_settings: None,
    }
}

#[test]
fn marking_a_large_folder_read_respects_server_command_limits() {
    let fake = fake_imap::FakeImap::start(false);
    let uids = fake.deliver("INBOX", 33913, "large-folder");
    fake.state.lock().unwrap().max_command_bytes = Some(4096);
    assert_eq!(
        imap_mark_read(&mut fake.session(), "INBOX", &uids).unwrap(),
        uids.len()
    );
    assert!(
        uids.iter()
            .all(|uid| fake.flags("INBOX", *uid).contains(&"\\Seen".into()))
    );
    assert!(
        fake.log()
            .iter()
            .filter(|line| line.starts_with("UID STORE"))
            .count()
            > 1
    );
}

#[test]
fn folder_read_includes_uncached_mail_and_recovers_a_lost_store_response() {
    let fake = fake_imap::FakeImap::start(false);
    fake.deliver("INBOX", 700, "folder-read");
    fake.set_flags("INBOX", 1, &["\\Seen"]);
    {
        let mut state = fake.state.lock().unwrap();
        state.max_command_bytes = Some(4096);
        state.drop_store_response_once = true;
    }
    let account = account(fake.port);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("read.db");
    let conn = Connection::open(&path).unwrap();
    init_mail_tables(&conn).unwrap();
    conn.execute("INSERT INTO mail_folders(account_id, name, unread, updated_at) VALUES(?1, 'INBOX', 700, 0)", [&account.config.session_id]).unwrap();
    // Local history is incomplete and UID 1 has a stale unread flag.
    for uid in [1, 700] {
        conn.execute("INSERT INTO mail_messages(account_id, folder, uid, subject, updated_at) VALUES(?1, 'INBOX', ?2, 'cached', 0)", params![account.config.session_id, uid]).unwrap();
    }
    drop(conn);
    let db = Arc::new(coordination::MailDatabase::new(path));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = read_actions::mark_read_cached(
        &MailImapPool::new(),
        &account,
        runtime.handle(),
        &db,
        "INBOX",
        vec![],
        true,
    )
    .unwrap();
    assert_eq!(result.marked, 699);
    assert_eq!(result.unread, Some(0));
    assert!((1..=700).all(|uid| fake.flags("INBOX", uid).contains(&"\\Seen".into())));
    assert!(
        unread_cached_uids(&db.lock().unwrap(), &account.config.session_id, "INBOX")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fake.log()
            .iter()
            .filter(|line| line.starts_with("LOGIN"))
            .count(),
        2
    );
    assert_eq!(
        fake.log()
            .iter()
            .filter(|line| line.starts_with("UID STORE"))
            .count(),
        4
    );
}

#[test]
fn interactive_body_completes_while_background_imap_is_busy() {
    let fake = fake_imap::FakeImap::start(false);
    let uid = fake.deliver("INBOX", 1, "interactive")[0];
    let account = account(fake.port);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let pool = Arc::new(MailImapPool::new());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let background = {
        let pool = pool.clone();
        let account = account.clone();
        let handle = runtime.handle().clone();
        std::thread::spawn(move || {
            with_imap_session(
                &pool,
                &account,
                &handle,
                ImapSessionOpts::background(),
                |imap| {
                    imap.fetch_body(&account, "INBOX", uid)?;
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                },
            )
        })
    };
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let (body_tx, body_rx) = mpsc::channel();
    let interactive = {
        let pool = pool.clone();
        let handle = runtime.handle().clone();
        std::thread::spawn(move || {
            let body = with_imap_session(
                &pool,
                &account,
                &handle,
                ImapSessionOpts::default(),
                |imap| imap.fetch_body(&account, "INBOX", uid),
            );
            body_tx.send(body).unwrap();
        })
    };
    let body = body_rx.recv_timeout(Duration::from_secs(2));
    // Always release and join before asserting, including a failed probe.
    release_tx.send(()).unwrap();
    background.join().unwrap().unwrap();
    interactive.join().unwrap();
    assert_eq!(
        body.expect("interactive request waited for background sync")
            .unwrap()
            .header
            .uid,
        uid
    );
    assert_eq!(
        fake.log()
            .iter()
            .filter(|line| line.starts_with("LOGIN"))
            .count(),
        2
    );
}

#[tokio::test(flavor = "current_thread")]
async fn cache_lock_wait_does_not_block_runtime_timers() {
    let directory = tempfile::tempdir().unwrap();
    let db = Arc::new(coordination::MailDatabase::new(
        directory.path().join("timers.db"),
    ));
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = {
        let db = db.clone();
        std::thread::spawn(move || {
            let _lock = db.lock().unwrap();
            locked_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(3));
        })
    };
    locked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let start = Instant::now();
    let timer = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let elapsed = start.elapsed();
        let _ = release_tx.send(());
        elapsed
    };
    let (result, elapsed) = tokio::join!(
        mail_db_task(db, "qa-responsiveness".into(), |db, _| db.query_row(
            "SELECT 42",
            [],
            |r| r.get::<_, i64>(0)
        )),
        timer,
    );
    holder.join().unwrap();
    assert_eq!(result.unwrap(), 42);
    assert!(
        elapsed < Duration::from_secs(1),
        "runtime was blocked for {elapsed:?}"
    );
}

#[test]
fn pruning_body_cache_does_not_rewrite_header_only_messages() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    conn.execute_batch(
        "WITH RECURSIVE n(uid) AS (VALUES(1) UNION ALL SELECT uid+1 FROM n WHERE uid < 4000)
         INSERT INTO mail_messages(account_id, folder, uid, subject, date_ts, updated_at)
         SELECT 'qa', 'INBOX', uid, 'searchable header', uid, 0 FROM n;
         UPDATE mail_messages SET body_text = 'searchable body', body_cached_at = 1 WHERE uid <= 3;
         CREATE TABLE body_writes(uid INTEGER);
         CREATE TRIGGER count_body_writes AFTER UPDATE OF body_text ON mail_messages BEGIN
             INSERT INTO body_writes VALUES(new.uid);
         END;",
    )
    .unwrap();
    let mut cache = MailCacheSettings {
        body_recent_limit: 2,
        ..MailCacheSettings::default()
    };
    prune_mail_cache(&conn, "qa", "INBOX", &cache).unwrap();
    let writes = || {
        conn.query_row("SELECT COUNT(*) FROM body_writes", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    assert_eq!(writes(), 1, "only the oldest cached body is evicted");
    prune_mail_cache(&conn, "qa", "INBOX", &cache).unwrap();
    assert_eq!(writes(), 1, "a settled cache must not churn the FTS index");
    cache.body_recent_limit = 0;
    prune_mail_cache(&conn, "qa", "INBOX", &cache).unwrap();
    assert_eq!(writes(), 3);
    prune_mail_cache(&conn, "qa", "INBOX", &cache).unwrap();
    assert_eq!(writes(), 3);
    let headers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mail_messages_fts WHERE mail_messages_fts MATCH 'header'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let bodies: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mail_messages_fts WHERE mail_messages_fts MATCH 'body'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((headers, bodies), (4000, 0));
}

#[test]
fn history_steps_index_only_new_contacts_and_replay_keeps_counts() {
    let fake = fake_imap::FakeImap::start(false);
    fake.deliver("INBOX", 6, "history");
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_contact_rebuild BEFORE DELETE ON mail_contacts BEGIN SELECT RAISE(ABORT, 'full contact rebuild'); END;").unwrap();
    let account = account(fake.port);
    let mut last = None;
    for request in [
        MailSyncRequestMode::Auto,
        MailSyncRequestMode::Backfill,
        MailSyncRequestMode::Backfill,
    ] {
        let state =
            sync::load_folder_sync_state(&conn, &account.config.session_id, "INBOX").unwrap();
        let outcome = sync::imap_sync_folder_step(
            &mut fake.session(),
            &account,
            "INBOX",
            &state,
            &StepParams {
                request,
                limit: 2,
                include_bodies: false,
                condstore: false,
            },
        )
        .unwrap();
        sync::apply_folder_step(
            &conn,
            &account.config.session_id,
            &outcome,
            &account.config.cache,
            sync::now_ms(),
        )
        .unwrap();
        last = Some(outcome);
    }
    let count = || {
        conn.query_row(
            "SELECT message_count FROM mail_contacts WHERE email = 'sender@example.com'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!(count(), 6);
    conn.execute_batch("DROP TRIGGER reject_contact_rebuild;")
        .unwrap();
    sync::apply_folder_step(
        &conn,
        &account.config.session_id,
        &last.unwrap(),
        &account.config.cache,
        sync::now_ms(),
    )
    .unwrap();
    assert_eq!(
        count(),
        6,
        "replaying a committed batch must not inflate contact counts"
    );
}

#[test]
fn smtp_acceptance_does_not_wait_for_or_retry_a_failed_sent_copy() {
    use std::io::{BufRead, BufReader};
    let smtp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut account = account(1); // IMAP deliberately unavailable.
    account.config.smtp.port = smtp.local_addr().unwrap().port();
    account.config.save_sent_copy = Some(true);
    let (accepted_tx, accepted_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = smtp.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(b"220 qa.example.test SMTP\r\n").unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut data = false;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            let command = line.trim_end();
            if data {
                if command == "." {
                    data = false;
                    accepted_tx.send(()).unwrap();
                    stream.write_all(b"250 accepted\r\n").unwrap();
                }
            } else if command.starts_with("EHLO") {
                stream
                    .write_all(b"250-qa.example.test\r\n250 AUTH PLAIN\r\n")
                    .unwrap();
            } else if command.starts_with("AUTH") {
                stream.write_all(b"235 authenticated\r\n").unwrap();
            } else if command == "DATA" {
                data = true;
                stream.write_all(b"354 send content\r\n").unwrap();
            } else if command == "QUIT" {
                stream.write_all(b"221 bye\r\n").unwrap();
                break;
            } else {
                stream.write_all(b"250 ok\r\n").unwrap();
            }
        }
    });
    let request = serde_json::from_value(serde_json::json!({
        "to": ["qa-recipient@example.test"], "subject": "disposable fixture", "textBody": "test only",
    })).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (result, pending) =
        outgoing::send_with_pending_copy(&account, &request, None, runtime.handle()).unwrap();
    assert!(result.accepted);
    assert!(result.sent_copy_folder.is_none());
    assert!(
        outgoing::store_pending_copy(
            &MailImapPool::new(),
            &account,
            pending.unwrap(),
            runtime.handle()
        )
        .is_err()
    );
    server.join().unwrap();
    assert_eq!(accepted_rx.try_iter().count(), 1);
}
