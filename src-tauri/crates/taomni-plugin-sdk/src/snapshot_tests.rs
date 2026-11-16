use super::{test_support::*, *};
use sha2::{Digest, Sha256};
use std::{fs, sync::atomic::Ordering, time::Duration};

#[test]
fn a_frozen_store_exports_committed_wal_and_keeps_ownership_until_matching_release() {
    let fixture = Fixture::new();
    let before = fs::read(fixture.root.path().join("plugins/mfa/data/mfa.db-wal")).unwrap();
    let mut session = SnapshotSession::default();
    let prepared = fixture.prepare(&mut session);
    assert_eq!(prepared, fixture.prepare(&mut session));
    assert_eq!(fixture.provider.freezes.load(Ordering::SeqCst), 1);
    let mut wrong = fixture.export_request(&prepared);
    wrong.barrier = SnapshotBarrierToken::parse(OTHER).unwrap();
    assert!(fixture.call(&mut session, SNAPSHOT_METHOD, &wrong).is_err());
    wrong = fixture.export_request(&prepared);
    wrong.staging = StagingToken::parse(OTHER).unwrap();
    assert!(fixture.call(&mut session, SNAPSHOT_METHOD, &wrong).is_err());
    assert!(session.is_paused());
    let result: SnapshotResult = serde_json::from_value(
        fixture
            .call(
                &mut session,
                SNAPSHOT_METHOD,
                fixture.export_request(&prepared),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result.job, prepared.job);
    assert_eq!(result.host_instance, fixture.host);
    assert_eq!(
        result.profile_generation,
        fixture.request.profile_generation
    );
    assert_eq!(result.files.len(), 1);
    let target = fixture.request.destination.absolute_job_root.join("mfa.db");
    let bytes = fs::read(&target).unwrap();
    assert_eq!(
        result.files[0].sha256.as_str(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert_eq!(result.files[0].size_bytes, bytes.len() as u64);
    let restored = rusqlite::Connection::open(&target).unwrap();
    assert_eq!(
        restored
            .query_row("SELECT secret FROM entries", [], |row| row
                .get::<_, Vec<u8>>(0))
            .unwrap(),
        [1, 0, 2, 255]
    );
    drop(restored);
    assert_eq!(
        before,
        fs::read(fixture.root.path().join("plugins/mfa/data/mfa.db-wal")).unwrap()
    );
    assert!(!target.with_file_name("mfa.db-wal").exists());
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        fixture
            .call(
                &mut session,
                SNAPSHOT_METHOD,
                fixture.export_request(&prepared)
            )
            .unwrap()
    );
    assert_eq!(fixture.provider.exports.load(Ordering::SeqCst), 1);
    assert!(fixture.provider.frozen.load(Ordering::SeqCst));
    let release = ReleaseSnapshot {
        job: prepared.job,
        barrier: prepared.barrier,
    };
    fixture
        .call(&mut session, SNAPSHOT_RELEASE_METHOD, &release)
        .unwrap();
    fixture
        .call(&mut session, SNAPSHOT_RELEASE_METHOD, &release)
        .unwrap();
    assert!(!session.is_paused());
    assert_eq!(fixture.provider.resumes.load(Ordering::SeqCst), 1);
    assert!(
        fixture
            .call(&mut session, SNAPSHOT_PREPARE_METHOD, &fixture.request)
            .is_err()
    );
}

#[test]
fn stale_job_generation_and_release_cannot_thaw_a_new_barrier() {
    let mut fixture = Fixture::new();
    let mut session = SnapshotSession::default();
    let mut stale = fixture.request.clone();
    stale.profile_generation = ProfileGeneration::parse(OTHER).unwrap();
    assert!(
        fixture
            .call(&mut session, SNAPSHOT_PREPARE_METHOD, stale)
            .is_err()
    );
    assert_eq!(fixture.provider.freezes.load(Ordering::SeqCst), 0);
    let first = fixture.prepare(&mut session);
    let old = ReleaseSnapshot {
        job: first.job,
        barrier: first.barrier,
    };
    fixture
        .call(&mut session, SNAPSHOT_RELEASE_METHOD, &old)
        .unwrap();
    fixture.request.job = SnapshotJobId::parse(OTHER).unwrap();
    fixture.prepare(&mut session);
    assert!(
        fixture
            .call(&mut session, SNAPSHOT_RELEASE_METHOD, &old)
            .is_err()
    );
    assert!(fixture.provider.frozen.load(Ordering::SeqCst));
    drop(session);
    assert!(!fixture.provider.frozen.load(Ordering::SeqCst));
    assert_eq!(fixture.provider.resumes.load(Ordering::SeqCst), 2);
}

#[test]
fn partial_freeze_export_failure_and_expired_jobs_resume_the_store() {
    let fixture = Fixture::new();
    let mut session = SnapshotSession::default();
    fixture.provider.fail_freeze.store(true, Ordering::SeqCst);
    assert!(
        fixture
            .call(&mut session, SNAPSHOT_PREPARE_METHOD, &fixture.request)
            .is_err()
    );
    assert!(!fixture.provider.frozen.load(Ordering::SeqCst));
    assert!(!session.is_paused());
    let mut fixture = Fixture::new();
    let mut session = SnapshotSession::default();
    fixture
        .request
        .destination
        .allowed_files
        .push(SafeRelativePath::parse("missing.bin").unwrap());
    let prepared = fixture.prepare(&mut session);
    assert!(
        fixture
            .call(
                &mut session,
                SNAPSHOT_METHOD,
                fixture.export_request(&prepared)
            )
            .is_err()
    );
    assert!(!fixture.provider.frozen.load(Ordering::SeqCst));
    let fixture = Fixture::new();
    let mut session = SnapshotSession::default();
    fixture.prepare(&mut session);
    session.paused.as_mut().unwrap().deadline = Instant::now() - Duration::from_millis(1);
    session.expire();
    assert!(!fixture.provider.frozen.load(Ordering::SeqCst));
}

#[test]
fn cancelled_export_cannot_publish_success_and_worker_cleanup_resumes_the_store() {
    let fixture = Fixture::new();
    let mut session = SnapshotSession::default();
    let prepared = fixture.prepare(&mut session);
    let op = operation();
    op.cancel();
    let result = session.dispatch(
        SNAPSHOT_METHOD,
        Some(serde_json::to_value(fixture.export_request(&prepared)).unwrap()),
        Some(&fixture.storage),
        Some(&fixture.host),
        Some(fixture.provider.clone()),
        op,
    );
    assert_eq!(result.unwrap_err().code, -32006);
    session.abort(); // Worker owns this cleanup even when cancellation precedes dispatch.
    assert!(!fixture.provider.frozen.load(Ordering::SeqCst));
    assert!(
        !fixture
            .request
            .destination
            .absolute_job_root
            .join("mfa.db")
            .exists()
    );
}
