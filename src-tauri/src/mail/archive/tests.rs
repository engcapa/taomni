use super::download::download_one;
use super::download::parse_chunk;
use super::lifetime::ArchiveJob;
use super::lifetime::ArchiveStatus;
use super::limits::CHUNK;
use super::limits::ContentFailures;
use super::sync::download_targets;
use super::sync::run_folder;
use crate::mail::MailAccountConfig;
use crate::mail::MailAuthMode;
use crate::mail::ResolvedMailAccount;
use crate::mail::coordination;
use crate::mail::fake_imap;
use crate::mail::storage;
use crate::mail::sync;
use crate::mail::{ActiveImapSession, extract_attachment, init_mail_tables};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use rusqlite::Connection;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

fn fixture(
    fake: &fake_imap::FakeImap,
) -> (
    tempfile::TempDir,
    ResolvedMailAccount,
    crate::state::MailDbHandle,
    ArchiveJob,
    ActiveImapSession,
) {
    let dir = tempfile::tempdir().unwrap();
    let db = Connection::open(dir.path().join("qa.db")).unwrap();
    init_mail_tables(&db).unwrap();
    let config: MailAccountConfig = serde_json::from_value(serde_json::json!({"sessionId":"qa","emailAddress":"qa@example.test","imap":{"host":"127.0.0.1","port":fake.port,"security":"none"},"smtp":{"host":"127.0.0.1","port":1,"security":"none"}})).unwrap();
    let account = ResolvedMailAccount {
        config,
        auth_mode: MailAuthMode::Password,
        imap_username: "user".into(),
        imap_password: "pass".into(),
        smtp_username: "user".into(),
        smtp_password: "pass".into(),
        network_settings: None,
    };
    let handle = Arc::new(coordination::MailDatabase::new(dir.path().join("qa.db")));
    let job = ArchiveJob {
        pause: AtomicBool::new(false),
        running: AtomicBool::new(true),
        status: Mutex::new(ArchiveStatus::default()),
        socket: Mutex::new(None),
    };
    let imap = ActiveImapSession::Plain {
        session: fake.session(),
        forward_task: None,
    };
    (dir, account, handle, job, imap)
}

#[test]
fn archive_publishes_first_batch_before_backfilling_history_and_drains_cached_mail() {
    let fake = fake_imap::FakeImap::start(false);
    fake.deliver("INBOX", 201, "Batched archive");
    let (_dir, account, handle, job, mut imap) = fixture(&fake);
    let mut failures = ContentFailures::default();
    run_folder(
        &mut imap,
        &account,
        &handle,
        "INBOX",
        false,
        &job,
        &mut failures,
    )
    .unwrap();
    let commands = fake.log();
    let first_raw = commands
        .iter()
        .position(|cmd| cmd.contains("BODY.PEEK[]<"))
        .unwrap();
    let second_headers = commands
        .iter()
        .enumerate()
        .filter(|(_, cmd)| cmd.contains("BODY.PEEK[HEADER]"))
        .nth(1)
        .unwrap()
        .0;
    assert!(
        first_raw < second_headers,
        "complete originals must precede history backfill"
    );
    assert_eq!(failures.count, 0);
    let status = job.status.lock().unwrap();
    assert_eq!(
        (
            status.saved,
            status.total,
            status.headers_synced,
            status.headers_total
        ),
        (201, 201, 201, Some(201))
    );
    drop(status);
    let db = handle.lock().unwrap();
    assert_eq!(storage::list(&db, "qa", 0).unwrap().len(), 200);
    assert_eq!(storage::list(&db, "qa", 200).unwrap().len(), 1);
    assert!(
        sync::load_folder_sync_state(&db, "qa", "INBOX")
            .unwrap()
            .complete
    );
    // Simulate an existing complete header cache with no originals. A new
    // scan must drain every cached message, not just its first MIME batch.
    db.execute("DELETE FROM mail_full_messages", []).unwrap();
    drop(db);
    let retry_job = ArchiveJob {
        status: Mutex::new(ArchiveStatus::default()),
        ..job
    };
    run_folder(
        &mut imap,
        &account,
        &handle,
        "INBOX",
        false,
        &retry_job,
        &mut failures,
    )
    .unwrap();
    assert_eq!(retry_job.status.lock().unwrap().saved, 201);
}

#[test]
fn batched_archive_attempts_unavailable_content_once_per_scan() {
    let fake = fake_imap::FakeImap::start(false);
    let uids = fake.deliver("INBOX", 101, "Batched failure");
    let bad = *uids.last().unwrap();
    fake.state
        .lock()
        .unwrap()
        .empty_bodies
        .insert(("INBOX".into(), bad));
    let (_dir, account, handle, job, mut imap) = fixture(&fake);
    let mut failures = ContentFailures::default();
    run_folder(
        &mut imap,
        &account,
        &handle,
        "INBOX",
        false,
        &job,
        &mut failures,
    )
    .unwrap();
    assert_eq!(failures.count, 1);
    let status = job.status.lock().unwrap();
    assert_eq!((status.saved, status.total), (100, 101));
    assert_eq!(
        fake.log()
            .iter()
            .filter(
                |cmd| cmd.contains(&format!("UID FETCH {bad} ")) && cmd.contains("BODY.PEEK[]<0.")
            )
            .count(),
        1
    );
}

#[test]
fn inaccurate_size_estimates_do_not_truncate_or_block_full_mime() {
    let fake = fake_imap::FakeImap::start(false);
    let (_dir, account, handle, job, mut imap) = fixture(&fake);
    for (length, advertised) in [
        (537, 0),
        (537, 532),
        (537, 999),
        (CHUNK + 17, CHUNK),
        (CHUNK * 2, CHUNK * 2 + 50),
    ] {
        let mut raw = fake_imap::raw_message("Inaccurate size", "Tue, 14 Nov 2023 22:13:20 +0000");
        raw.resize(length, b'x');
        let uid = fake.deliver_raw("INBOX", raw.clone());
        fake.state
            .lock()
            .unwrap()
            .reported_sizes
            .insert(("INBOX".into(), uid), advertised);
        download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).unwrap();
        assert_eq!(
            storage::read(&handle.lock().unwrap(), "qa", "INBOX", uid)
                .unwrap()
                .unwrap(),
            raw
        );
        assert!(!fake.flags("INBOX", uid).contains(&"\\Seen".into()));
    }
}

#[test]
fn unavailable_body_does_not_block_others_or_become_a_permanent_skip() {
    let fake = fake_imap::FakeImap::start(false);
    let uids = fake.deliver("INBOX", 3, "Content failure");
    let bad = uids[2];
    fake.state
        .lock()
        .unwrap()
        .empty_bodies
        .insert(("INBOX".into(), bad));
    let (_dir, account, handle, job, mut imap) = fixture(&fake);
    let mut failures = ContentFailures::default();
    download_targets(
        &mut imap,
        &account,
        &handle,
        "INBOX",
        1000,
        uids.iter().rev().copied().collect(),
        &job,
        &mut failures,
    )
    .unwrap();
    assert_eq!(failures.count, 1);
    assert!(failures.message().contains(&format!("INBOX, UID {bad}")));
    assert_eq!(job.status.lock().unwrap().saved, 2);
    {
        let db = handle.lock().unwrap();
        assert!(storage::read(&db, "qa", "INBOX", bad).unwrap().is_none());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM mail_archive_skipped", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        for uid in &uids[..2] {
            assert!(storage::read(&db, "qa", "INBOX", *uid).unwrap().is_some());
        }
    }
    let mut retry = ContentFailures::default();
    download_targets(
        &mut imap,
        &account,
        &handle,
        "INBOX",
        1000,
        vec![bad],
        &job,
        &mut retry,
    )
    .unwrap();
    assert_eq!(retry.count, 1);
    fake.state.lock().unwrap().empty_bodies.clear();
    let mut recovered = ContentFailures::default();
    download_targets(
        &mut imap,
        &account,
        &handle,
        "INBOX",
        1000,
        vec![bad],
        &job,
        &mut recovered,
    )
    .unwrap();
    assert_eq!(recovered.count, 0);
    assert!(
        storage::read(&handle.lock().unwrap(), "qa", "INBOX", bad)
            .unwrap()
            .is_some()
    );
}

#[test]
fn resumed_parts_validate_actual_eof_and_size_hint_changes_reset_safely() {
    let fake = fake_imap::FakeImap::start(false);
    let mut raw =
        fake_imap::raw_message("Resume inaccurate size", "Tue, 14 Nov 2023 22:13:20 +0000");
    raw.resize(CHUNK + 57, b'x');
    let uid = fake.deliver_raw("INBOX", raw.clone());
    let (_dir, account, handle, job, mut imap) = fixture(&fake);
    let root = storage::account_root(&handle.lock().unwrap(), "qa").unwrap();
    let path = root.join("partial").join(format!(
        "{}-1000-{uid}.part",
        hex::encode(Sha256::digest(b"INBOX"))
    ));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, &raw[..CHUNK]).unwrap();
    // Legacy numeric metadata remains readable. A claimed complete prefix
    // must not be published if the provider has more bytes at that offset.
    fs::write(path.with_extension("json"), CHUNK.to_string()).unwrap();
    fake.state
        .lock()
        .unwrap()
        .reported_sizes
        .insert(("INBOX".into(), uid), CHUNK);
    download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).unwrap();
    assert_eq!(
        storage::read(&handle.lock().unwrap(), "qa", "INBOX", uid)
            .unwrap()
            .unwrap(),
        raw
    );
    let next = fake.deliver_raw("INBOX", raw.clone());
    let changed = path.with_file_name(format!(
        "{}-1000-{next}.part",
        hex::encode(Sha256::digest(b"INBOX"))
    ));
    fs::write(&changed, &raw[..CHUNK]).unwrap();
    fs::write(changed.with_extension("json"), "10").unwrap();
    assert!(
        download_one(&mut imap, &account, &handle, "INBOX", next, 1000, &job)
            .unwrap_err()
            .contains("size changed")
    );
    assert!(!changed.exists());
    assert!(
        storage::read(&handle.lock().unwrap(), "qa", "INBOX", next)
            .unwrap()
            .is_none()
    );
    download_one(&mut imap, &account, &handle, "INBOX", next, 1000, &job).unwrap();
    assert_eq!(
        storage::read(&handle.lock().unwrap(), "qa", "INBOX", next)
            .unwrap()
            .unwrap(),
        raw
    );
}

#[test]
fn orphaned_resume_metadata_does_not_trap_retry_after_size_changes() {
    let fake = fake_imap::FakeImap::start(false);
    let raw = fake_imap::raw_message("Orphaned metadata", "Tue, 14 Nov 2023 22:13:20 +0000");
    let (_dir, account, handle, job, mut imap) = fixture(&fake);
    let root = storage::account_root(&handle.lock().unwrap(), "qa").unwrap();
    for empty_partial in [false, true] {
        let uid = fake.deliver_raw("INBOX", raw.clone());
        let path = root.join("partial").join(format!(
            "{}-1000-{uid}.part",
            hex::encode(Sha256::digest(b"INBOX"))
        ));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path.with_extension("json"), "1").unwrap();
        if empty_partial {
            fs::write(&path, []).unwrap();
        }
        download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).unwrap();
        assert_eq!(
            storage::read(&handle.lock().unwrap(), "qa", "INBOX", uid)
                .unwrap()
                .unwrap(),
            raw
        );
        assert!(!path.exists());
        assert!(!path.with_extension("json").exists());
    }
}

#[test]
fn loopback_resume_saves_complete_mime_and_leaves_it_unread() {
    let fake = fake_imap::FakeImap::start(false);
    let raw=format!("Subject: Complete original\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nOffline body\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=large.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--b--\r\n",BASE64_STANDARD.encode(vec![17u8;600_000])).into_bytes();
    let uid = fake.deliver_raw("INBOX", raw.clone());
    let dir = tempfile::tempdir().unwrap();
    let db = Connection::open(dir.path().join("qa.db")).unwrap();
    init_mail_tables(&db).unwrap();
    let config:MailAccountConfig=serde_json::from_value(serde_json::json!({"sessionId":"qa","emailAddress":"qa@example.test","imap":{"host":"127.0.0.1","port":fake.port,"security":"none"},"smtp":{"host":"127.0.0.1","port":1,"security":"none"}})).unwrap();
    let account = ResolvedMailAccount {
        config,
        auth_mode: MailAuthMode::Password,
        imap_username: "user".into(),
        imap_password: "pass".into(),
        smtp_username: "user".into(),
        smtp_password: "pass".into(),
        network_settings: None,
    };
    let root = storage::account_root(&db, "qa").unwrap();
    let partial_dir = root.join("partial");
    fs::create_dir_all(&partial_dir).unwrap();
    let path = partial_dir.join(format!(
        "{}-1000-{uid}.part",
        hex::encode(Sha256::digest(b"INBOX"))
    ));
    fs::write(&path, &raw[..CHUNK]).unwrap();
    fs::write(
        path.with_extension("json"),
        serde_json::to_vec(&raw.len()).unwrap(),
    )
    .unwrap();
    let job = ArchiveJob {
        pause: AtomicBool::new(false),
        running: AtomicBool::new(true),
        status: Mutex::new(ArchiveStatus::default()),
        socket: Mutex::new(None),
    };
    drop(db);
    let handle = Arc::new(coordination::MailDatabase::new(dir.path().join("qa.db")));
    let mut imap = ActiveImapSession::Plain {
        session: fake.session(),
        forward_task: None,
    };
    download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).unwrap();
    let db = handle.lock().unwrap();
    assert_eq!(
        storage::read(&db, "qa", "INBOX", uid).unwrap().unwrap(),
        raw
    );
    assert_eq!(
        extract_attachment(&raw, 0).unwrap().bytes,
        vec![17u8; 600_000]
    );
    assert!(!path.exists());
    assert!(
        fake.log()
            .iter()
            .any(|line| line.contains("BODY.PEEK[]<262144.262144>"))
    );
    assert!(!fake.flags("INBOX", uid).contains(&"\\Seen".into()));
    drop(db);
    // Simulate a process ending after the last chunk was fsynced but before
    // compression. Resume must validate the actual EOF, not only SIZE.
    let next_uid = fake.deliver_raw("INBOX", raw.clone());
    let complete_path = partial_dir.join(format!(
        "{}-1000-{next_uid}.part",
        hex::encode(Sha256::digest(b"INBOX"))
    ));
    fs::write(&complete_path, &raw).unwrap();
    fs::write(
        complete_path.with_extension("json"),
        serde_json::to_vec(&raw.len()).unwrap(),
    )
    .unwrap();
    download_one(&mut imap, &account, &handle, "INBOX", next_uid, 1000, &job).unwrap();
    assert_eq!(
        storage::read(&handle.lock().unwrap(), "qa", "INBOX", next_uid)
            .unwrap()
            .unwrap(),
        raw
    );
    assert!(!complete_path.exists());
    let requests = fake.log();
    assert!(requests.iter().any(|line| line.contains(&format!(
        "UID FETCH {next_uid} (UID RFC822.SIZE BODY.PEEK[]<{}.{}>)",
        raw.len(),
        CHUNK
    ))));
    job.pause.store(true, Ordering::Release);
    assert!(download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).is_err());
}

#[test]
fn resumed_fetch_checks_origin_uid_size_and_literal() {
    let ok = b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<3> {3}\r\ndef)\r\n";
    assert_eq!(parse_chunk(ok, 7, 3).unwrap(), (6, b"def".to_vec()));
    assert!(parse_chunk(ok, 7, 0).is_err());
    assert!(parse_chunk(ok, 8, 3).is_err());
    assert!(
        parse_chunk(
            b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[] {3}\r\nabc)\r\n",
            7,
            3
        )
        .is_err()
    );
    assert_eq!(
        parse_chunk(
            b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<5> {3}\r\nabc)\r\n",
            7,
            5
        )
        .unwrap(),
        (6, b"abc".to_vec())
    );
    assert_eq!(
        parse_chunk(
            b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<6> {0}\r\n)\r\n",
            7,
            6
        )
        .unwrap(),
        (6, vec![])
    );
    assert_eq!(parse_chunk(b"* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n* 1 FETCH (UID 7 RFC822.SIZE 9)\r\n* 1 FETCH (UID 7 BODY[]<3> {3}\r\ndef)\r\n", 7, 3).unwrap(), (9, b"def".to_vec()));
    assert_eq!(
        parse_chunk(b"* 1 FETCH (UID 7 RFC822.SIZE 8 BODY[] NIL)\r\n", 7, 6).unwrap(),
        (8, vec![])
    );
    assert!(
        parse_chunk(
            b"* 1 FETCH (UID 7 RFC822.SIZE 8 BODY[]<0> {0}\r\n)\r\n",
            7,
            0
        )
        .unwrap_err()
        .contains("offset 0")
    );
    assert!(parse_chunk(b"* 1 FETCH (UID 7 RFC822.SIZE 0 BODY[] NIL)\r\n", 7, 0).is_err());
}
