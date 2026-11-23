use super::*;

struct ObserveMailboxLease<'a>(&'a Path);

impl MutationSession for ObserveMailboxLease<'_> {
    fn with_session<T>(
        &mut self,
        mut operation: impl FnMut(&mut SendMutation<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        assert!(ProcessLock::try_at(self.0, MAIL_MUTATION_LOCK)?.is_none());
        operation(&mut |request| match request {
            MutationRequest::Select { .. } => Ok(MutationReply::Selected {
                validity: 1,
                move_supported: true,
                uidplus: true,
            }),
            MutationRequest::Copy { uids, .. } if uids == [17] => Ok(MutationReply::Applied),
            _ => panic!("unexpected mutation request"),
        })
    }
}

#[test]
#[ignore = "Requires an independent process on a GitHub runner"]
fn account_lease_blocks_an_independent_process() {
    const MAILBOX_PATH: &str = "TAOMNI_MAIL_MUTATION_TEST_PATH";
    if let Some(path) = std::env::var_os(MAILBOX_PATH) {
        assert!(
            ProcessLock::try_at(Path::new(&path), MAIL_MUTATION_LOCK)
                .unwrap()
                .is_none()
        );
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mailbox.db");
    let lease = ProcessLock::try_at(&path, MAIL_MUTATION_LOCK)
        .unwrap()
        .unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "mutation_journal::tests::account_lease_blocks_an_independent_process",
            "--ignored",
        ])
        .env(MAILBOX_PATH, &path)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("1 passed"), "{stdout}");
    drop(lease);
    assert!(
        ProcessLock::try_at(&path, MAIL_MUTATION_LOCK)
            .unwrap()
            .is_some()
    );
}

#[test]
fn account_lease_precedes_network_replies_and_releases_after_the_operation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mailbox.db");
    let database = MailDatabase::new(path.clone(), init_mail_tables);
    let mut session = ObserveMailboxLease(&path);
    let request = || MutationJobRequest {
        account_id: "account",
        endpoint: "test-mail:143:account",
        folder: "INBOX",
        target: "Archive",
        uids: vec![17],
        kind: Kind::Copy,
        all: false,
        operation_id: Some("request".to_owned()),
    };

    let lease = ProcessLock::try_at(&path, MAIL_MUTATION_LOCK)
        .unwrap()
        .unwrap();
    let error = run_mutation(&database, &mut session, request()).unwrap_err();
    assert!(error.contains("Another Taomni instance"), "{error}");
    drop(lease);

    let result = run_mutation(&database, &mut session, request()).unwrap();
    assert_eq!(result.completed_uids, [17]);
    assert!(result.error.is_none());
    assert!(
        ProcessLock::try_at(&path, MAIL_MUTATION_LOCK)
            .unwrap()
            .is_some()
    );
}
