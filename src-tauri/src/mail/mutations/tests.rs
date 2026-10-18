use super::*;

struct Harness {
    fake: fake_imap::FakeImap,
    db: MailDbHandle,
    account: ResolvedMailAccount,
    runtime: tokio::runtime::Runtime,
    _directory: tempfile::TempDir,
}

impl Harness {
    fn new(count: usize) -> Self {
        let fake = fake_imap::FakeImap::start(false);
        fake.add_folder("Trash", 2000);
        fake.deliver("INBOX", count, "mutation");
        let account = ResolvedMailAccount {
            config: serde_json::from_value(serde_json::json!({
                "sessionId": "qa-mutations", "emailAddress": "user@example.test",
                "imap": { "host": "127.0.0.1", "port": fake.port, "security": "none" },
                "smtp": { "host": "127.0.0.1", "port": 1, "security": "none" }
            }))
            .unwrap(),
            auth_mode: MailAuthMode::Password,
            imap_username: "user".into(),
            imap_password: "pass".into(),
            smtp_username: "user".into(),
            smtp_password: "pass".into(),
            network_settings: None,
        };
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(coordination::MailDatabase::new(
            directory.path().join("mail.db"),
        ));
        {
            let conn = db.lock().unwrap();
            init_mail_tables(&conn).unwrap();
            for uid in 1..=count as u32 {
                upsert_message(&conn, &empty_cached_message("qa-mutations", "INBOX", uid)).unwrap();
            }
        }
        Self {
            fake,
            db,
            account,
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap(),
            _directory: directory,
        }
    }

    fn run(&self, kind: Kind, uids: Vec<u32>, id: Option<String>) -> Progress {
        run_cached(
            &MailImapPool::new(),
            &self.account,
            self.runtime.handle(),
            &self.db,
            "INBOX",
            uids,
            if kind == Kind::Delete { "" } else { "Trash" },
            kind,
            false,
            id,
        )
        .unwrap()
    }

    fn copies(&self) -> usize {
        self.fake
            .log()
            .iter()
            .filter(|c| c.starts_with("UID COPY"))
            .count()
    }
}

#[test]
fn copy_limit_boundaries_and_single_message_failure() {
    for count in [19, 20, 21, 200, 251] {
        let h = Harness::new(count);
        {
            let mut s = h.fake.state.lock().unwrap();
            s.supports_move = false;
            s.max_transfer_count = Some(20);
        }
        let result = h.run(Kind::Move, (1..=count as u32).collect(), None);
        assert_eq!(result.error, None);
        assert_eq!(result.completed_uids.len(), count);
        assert_eq!(h.fake.uids("Trash").len(), count);
        assert!(h.fake.uids("INBOX").is_empty());
        assert!(!h.fake.log().iter().any(|c| c.starts_with("UID MOVE")));
    }
    let h = Harness::new(1);
    h.fake.state.lock().unwrap().max_transfer_count = Some(0);
    let result = h.run(Kind::Copy, vec![1], None);
    assert!(result.error.is_some());
    assert_eq!(result.pending_uids, [1]);
    assert_eq!(h.copies(), 1);
}

#[test]
fn partial_batches_commit_cache_and_resume_without_duplicate_copy() {
    let h = Harness::new(200);
    {
        let mut s = h.fake.state.lock().unwrap();
        s.supports_move = false;
        s.max_transfer_count = Some(25);
        s.reject_transfer_after = Some(25);
    }
    let first = h.run(Kind::Move, (1..=200).collect(), None);
    assert_eq!(first.completed_uids.len(), 25);
    assert_eq!(first.pending_uids.len(), 175);
    assert!(first.retryable);
    assert!(
        cached_header(&h.db.lock().unwrap(), "qa-mutations", "INBOX", 1)
            .unwrap()
            .is_none()
    );
    assert!(
        cached_header(&h.db.lock().unwrap(), "qa-mutations", "INBOX", 26)
            .unwrap()
            .is_some()
    );
    h.fake.state.lock().unwrap().reject_transfer_after = None;
    let final_result = h.run(Kind::Move, (1..=200).collect(), Some(first.operation_id));
    assert_eq!(final_result.error, None);
    assert_eq!(final_result.completed_uids.len(), 200);
    assert_eq!(h.fake.uids("Trash").len(), 200);
}

#[test]
fn confirmed_copy_resumes_store_after_reconnect_without_recopying() {
    let h = Harness::new(3);
    {
        let mut s = h.fake.state.lock().unwrap();
        s.supports_move = false;
        s.reject_deleted_store_once = true;
    }
    let first = h.run(Kind::Move, vec![1, 2, 3], None);
    assert!(first.error.is_some());
    assert_eq!(h.fake.uids("Trash").len(), 3);
    assert_eq!(h.copies(), 1);
    // A new pool and no client operation id simulate reopening the app and
    // repeating the same selection. The durable unfinished receipt is reused.
    let second = h.run(Kind::Move, vec![1, 2, 3], None);
    assert_eq!(second.operation_id, first.operation_id);
    assert_eq!(second.error, None);
    assert_eq!(h.copies(), 1);
    assert!(h.fake.uids("INBOX").is_empty());
}

#[test]
fn lost_copy_response_is_not_replayed_on_reconnect_or_retry() {
    let h = Harness::new(3);
    h.fake.state.lock().unwrap().drop_copy_response_once = true;
    let first = h.run(Kind::Copy, vec![1, 2, 3], None);
    assert_eq!(first.uncertain_uids, [1, 2, 3]);
    assert!(!first.retryable);
    let second = h.run(Kind::Copy, vec![1, 2, 3], Some(first.operation_id));
    assert_eq!(second.uncertain_uids, [1, 2, 3]);
    assert_eq!(h.copies(), 1);
    assert_eq!(h.fake.uids("Trash").len(), 3);
    assert_eq!(h.fake.uids("INBOX").len(), 3);
}

#[test]
fn targeted_expunge_preserves_other_deleted_mail_and_no_uidplus_never_expunges() {
    for uidplus in [true, false] {
        let h = Harness::new(4);
        {
            let mut s = h.fake.state.lock().unwrap();
            s.supports_move = false;
            s.supports_uidplus = uidplus;
        }
        h.fake.set_flags("INBOX", 4, &["\\Deleted"]);
        let result = h.run(Kind::Move, vec![1, 2, 3], None);
        assert!(h.fake.uids("INBOX").contains(&4));
        assert!(!h.fake.log().iter().any(|c| c == "EXPUNGE"));
        if uidplus {
            assert_eq!(result.error, None);
            assert_eq!(h.fake.uids("INBOX"), [4]);
        } else {
            assert!(result.detail.unwrap().contains("UIDPLUS"));
            assert_eq!(h.fake.uids("INBOX").len(), 4);
        }
    }
}

#[test]
fn completed_operation_id_is_idempotent_but_new_copy_is_allowed() {
    let h = Harness::new(3);
    let first = h.run(Kind::Copy, vec![1, 2, 3], Some("client-request".into()));
    let again = h.run(Kind::Copy, vec![1, 2, 3], Some(first.operation_id));
    assert_eq!(again.completed_uids, [1, 2, 3]);
    assert_eq!(h.copies(), 1);
    let next = h.run(
        Kind::Copy,
        vec![1, 2, 3],
        Some("intentional-second-copy".into()),
    );
    assert_eq!(next.error, None);
    assert_eq!(h.fake.uids("Trash").len(), 6);
}

#[test]
fn uidvalidity_change_blocks_resuming_old_uids() {
    let h = Harness::new(3);
    {
        let mut s = h.fake.state.lock().unwrap();
        s.supports_move = false;
        s.reject_deleted_store_once = true;
    }
    let first = h.run(Kind::Move, vec![1, 2, 3], None);
    h.fake.reset_uid_validity("INBOX", 9000);
    let second = h.run(Kind::Move, vec![1, 2, 3], Some(first.operation_id));
    assert!(second.error.unwrap().contains("UIDVALIDITY"));
    assert_eq!(h.copies(), 1);
}

#[test]
fn move_and_permanent_delete_use_bounded_commands() {
    for kind in [Kind::Move, Kind::Delete] {
        let h = Harness::new(251);
        h.fake.state.lock().unwrap().max_command_bytes = Some(COMMAND_BYTES);
        let result = h.run(kind, (1..=251).chain([0, 1, 2]).collect(), None);
        assert_eq!(result.error, None);
        assert_eq!(result.completed_uids.len(), 251);
        assert!(h.fake.uids("INBOX").is_empty());
        assert!(!h.fake.log().iter().any(|c| c == "EXPUNGE"));
    }
}

#[test]
fn lost_store_response_retries_only_the_idempotent_delete_stage() {
    let h = Harness::new(3);
    {
        let mut s = h.fake.state.lock().unwrap();
        s.supports_move = false;
        s.drop_store_response_once = true;
    }
    let first = h.run(Kind::Move, vec![1, 2, 3], None);
    assert!(first.retryable);
    let second = h.run(Kind::Move, vec![1, 2, 3], Some(first.operation_id));
    assert_eq!(second.error, None);
    assert_eq!(h.copies(), 1);
    assert_eq!(h.fake.uids("Trash").len(), 3);
}

#[test]
fn move_rejection_does_not_fall_back_to_copy() {
    let h = Harness::new(3);
    h.fake.state.lock().unwrap().reject_transfer_after = Some(0);
    let result = h.run(Kind::Move, vec![1, 2, 3], None);
    assert!(result.error.is_some());
    assert_eq!(h.copies(), 0);
    assert_eq!(h.fake.uids("INBOX").len(), 3);
}

#[test]
fn empty_folder_captures_server_uids_even_with_a_client_request_id() {
    let h = Harness::new(3);
    let result = run_cached(
        &MailImapPool::new(),
        &h.account,
        h.runtime.handle(),
        &h.db,
        "INBOX",
        vec![],
        "",
        Kind::Delete,
        true,
        Some("empty-request".into()),
    )
    .unwrap();
    assert_eq!(result.completed_uids, [1, 2, 3]);
    h.fake.deliver("INBOX", 1, "arrived-later");
    let repeat = run_cached(
        &MailImapPool::new(),
        &h.account,
        h.runtime.handle(),
        &h.db,
        "INBOX",
        vec![],
        "",
        Kind::Delete,
        true,
        Some(result.operation_id),
    )
    .unwrap();
    assert_eq!(repeat.completed_uids, [1, 2, 3]);
    assert_eq!(h.fake.uids("INBOX"), [4]);
}
