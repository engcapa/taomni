use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use super::*;
use rusqlite::Connection;

#[derive(Default)]
struct Observer {
    cancelled: AtomicBool,
    cancel_at: Option<SnapshotPhase>,
    progress: Mutex<Vec<SnapshotProgress>>,
}

impl SnapshotObserver for Observer {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn progress(&self, progress: SnapshotProgress) {
        self.progress.lock().unwrap().push(progress);
        if self.cancel_at == Some(progress.phase) {
            self.cancelled.store(true, Ordering::Release);
        }
    }
}

fn control(observer: &Arc<Observer>) -> SnapshotControl {
    SnapshotControl::new(Instant::now() + Duration::from_secs(5), observer.clone())
}

fn rows(path: &Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT count(*) FROM entries", [], |row| row.get(0))
        .unwrap()
}

fn assert_no_partials(root: &Path) {
    for entry in fs::read_dir(root).unwrap() {
        let name = entry.unwrap().file_name();
        assert!(
            !name.to_string_lossy().starts_with(".taomni-snapshot-"),
            "{name:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn linked_database_or_parent_cannot_bypass_readonly_source_validation() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let source = root.join("source.db");
    Connection::open(&source)
        .unwrap()
        .execute_batch("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('original');")
        .unwrap();
    let before = fs::read(&source).unwrap();
    let target = root.join("snapshot.db");
    fs::write(&target, b"previous-complete-artifact").unwrap();
    let linked_file = root.join("linked.db");
    symlink(&source, &linked_file).unwrap();
    let linked_parent = root.join("linked-parent");
    symlink(&root, &linked_parent).unwrap();
    for alias in [linked_file, linked_parent.join("source.db")] {
        assert!(
            snapshot_existing(
                &alias,
                &target,
                &SnapshotOptions::default(),
                &SnapshotControl::with_timeout(Duration::from_secs(5)),
            )
            .is_err(),
            "linked source must remain rejected: {alias:?}"
        );
        assert_eq!(fs::read(&source).unwrap(), before);
        assert_eq!(fs::read(&target).unwrap(), b"previous-complete-artifact");
        assert_no_partials(&root);
    }
}

#[test]
fn existing_wal_snapshot_contains_committed_pages_without_mutating_the_source() {
    let directory = tempfile::tempdir().unwrap();
    // SQLite NOFOLLOW rejects ancestor aliases too (macOS /var -> /private/var).
    // Match the production caller's canonical ProfileRoot, without relaxing it.
    let root = directory.path().canonicalize().unwrap();
    let source_path = root.join("source.db");
    let target = root.join("snapshot.db");
    let source = Connection::open(&source_path).unwrap();
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('first');",
        )
        .unwrap();
    source
        .execute("INSERT INTO entries VALUES ('committed-in-wal')", [])
        .unwrap();
    let source_bytes = fs::read(&source_path).unwrap();
    let wal = source_path.with_extension("db-wal");
    let wal_bytes = fs::read(&wal).unwrap();
    assert!(!wal_bytes.is_empty());
    let observer = Arc::new(Observer::default());
    let outcome = snapshot_existing(
        &source_path,
        &target,
        &SnapshotOptions::default(),
        &control(&observer),
    )
    .unwrap();
    let SnapshotOutcome::Created(summary) = outcome else {
        panic!("missing snapshot");
    };
    assert!(summary.size_bytes > 0 && summary.total_pages > 0);
    assert_eq!(rows(&target), 2);
    assert_eq!(fs::read(source_path).unwrap(), source_bytes);
    assert_eq!(fs::read(wal).unwrap(), wal_bytes);
    assert!(!target.with_extension("db-wal").exists());
    assert!(!target.with_extension("db-shm").exists());
    let events = observer.progress.lock().unwrap();
    assert_eq!(events.first().unwrap().phase, SnapshotPhase::Starting);
    assert_eq!(events.last().unwrap().phase, SnapshotPhase::Completed);
    assert!(
        events
            .iter()
            .any(|event| event.phase == SnapshotPhase::Verifying)
    );
    assert_no_partials(directory.path());
}

#[test]
fn uncommitted_wal_transaction_is_excluded() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let path = root.join("source.db");
    let source = Connection::open(&path).unwrap();
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE entries(value TEXT);
        INSERT INTO entries VALUES ('committed'); BEGIN IMMEDIATE;
        INSERT INTO entries VALUES ('not committed');",
        )
        .unwrap();
    let target = root.join("snapshot.db");
    snapshot_existing(
        &path,
        &target,
        &SnapshotOptions::default(),
        &SnapshotControl::with_timeout(Duration::from_secs(5)),
    )
    .unwrap();
    assert_eq!(rows(&target), 1);
    source.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn never_used_database_creates_neither_source_nor_output_directory() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("unused/mfa.db");
    let target = directory.path().join("output/snapshot.db");
    let outcome = snapshot_existing(
        &source,
        &target,
        &SnapshotOptions::default(),
        &SnapshotControl::with_timeout(Duration::from_secs(1)),
    )
    .unwrap();
    assert_eq!(outcome, SnapshotOutcome::Missing);
    assert!(!source.exists());
    assert!(!target.parent().unwrap().exists());
}

#[test]
fn cancelling_copy_verify_or_publish_preserves_the_working_artifact() {
    for phase in [
        SnapshotPhase::Copying,
        SnapshotPhase::Verifying,
        SnapshotPhase::Publishing,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let source = Connection::open_in_memory().unwrap();
        source
            .execute_batch(
                "CREATE TABLE entries(value BLOB); INSERT INTO entries VALUES (zeroblob(262144));",
            )
            .unwrap();
        let target = directory.path().join("snapshot.db");
        fs::write(&target, b"previous-complete-artifact").unwrap();
        let observer = Arc::new(Observer {
            cancel_at: Some(phase),
            ..Observer::default()
        });
        let options = SnapshotOptions {
            pages_per_step: 1,
            ..SnapshotOptions::default()
        };
        let result = snapshot_connection(&source, &target, &options, &control(&observer));
        assert!(
            matches!(result, Err(SnapshotError::Cancelled)),
            "{phase:?}: {result:?}"
        );
        assert_eq!(fs::read(target).unwrap(), b"previous-complete-artifact");
        assert_no_partials(directory.path());
    }
}

#[test]
fn busy_source_is_cancellable_and_does_not_replace_a_previous_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let source = Connection::open_in_memory().unwrap();
    source
        .execute_batch(
            "CREATE TABLE entries(value TEXT); BEGIN IMMEDIATE;
        INSERT INTO entries VALUES ('uncommitted');",
        )
        .unwrap();
    let target = directory.path().join("snapshot.db");
    fs::write(&target, b"working").unwrap();
    let observer = Arc::new(Observer {
        cancel_at: Some(SnapshotPhase::WaitingForDatabase),
        ..Observer::default()
    });
    let result = snapshot_connection(
        &source,
        &target,
        &SnapshotOptions::default(),
        &control(&observer),
    );
    assert!(
        matches!(result, Err(SnapshotError::Cancelled)),
        "{result:?}"
    );
    assert!(
        observer
            .progress
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.phase == SnapshotPhase::WaitingForDatabase)
    );
    assert_eq!(fs::read(target).unwrap(), b"working");
    assert_no_partials(directory.path());
}

#[test]
fn successful_snapshot_atomically_replaces_an_old_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let source = Connection::open_in_memory().unwrap();
    source
        .execute_batch("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('ready');")
        .unwrap();
    let target = directory.path().join("snapshot.db");
    fs::write(&target, b"previous").unwrap();
    snapshot_connection(
        &source,
        &target,
        &SnapshotOptions::default(),
        &SnapshotControl::with_timeout(Duration::from_secs(1)),
    )
    .unwrap();
    assert_eq!(rows(&target), 1);
    assert_no_partials(directory.path());
}

#[test]
fn broken_source_leaves_prior_artifact_and_no_partial() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("broken.db");
    fs::write(&source, b"not a SQLite database").unwrap();
    let target = directory.path().join("snapshot.db");
    fs::write(&target, b"working").unwrap();
    assert!(
        snapshot_existing(
            &source,
            &target,
            &SnapshotOptions::default(),
            &SnapshotControl::with_timeout(Duration::from_secs(1))
        )
        .is_err()
    );
    assert_eq!(fs::read(target).unwrap(), b"working");
    assert_no_partials(directory.path());
}

#[test]
fn source_cannot_be_overwritten_and_expired_work_creates_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.db");
    let source = Connection::open(&path).unwrap();
    source
        .execute_batch("CREATE TABLE entries(value TEXT)")
        .unwrap();
    assert!(matches!(
        snapshot_connection(
            &source,
            &path,
            &SnapshotOptions::default(),
            &SnapshotControl::with_timeout(Duration::from_secs(1))
        ),
        Err(SnapshotError::SourceIsDestination)
    ));
    let target = directory.path().join("new.db");
    assert!(matches!(
        snapshot_connection(
            &source,
            &target,
            &SnapshotOptions::default(),
            &SnapshotControl::with_timeout(Duration::ZERO)
        ),
        Err(SnapshotError::TimedOut)
    ));
    assert!(!target.exists());
    assert_eq!(rows(&path), 0);
}

#[test]
fn invalid_step_options_are_rejected_before_creating_files() {
    let directory = tempfile::tempdir().unwrap();
    let source = Connection::open_in_memory().unwrap();
    let target = directory.path().join("new.db");
    let options = SnapshotOptions {
        pages_per_step: 0,
        ..SnapshotOptions::default()
    };
    assert!(matches!(
        snapshot_connection(
            &source,
            &target,
            &options,
            &SnapshotControl::with_timeout(Duration::from_secs(1))
        ),
        Err(SnapshotError::InvalidOptions)
    ));
    assert!(!target.exists());
}

#[test]
fn a_destination_with_an_existing_wal_is_never_replaced_or_cleaned() {
    let directory = tempfile::tempdir().unwrap();
    let source = Connection::open_in_memory().unwrap();
    let target = directory.path().join("snapshot.db");
    let wal = directory.path().join("snapshot.db-wal");
    fs::write(&target, b"working-database").unwrap();
    fs::write(&wal, b"working-wal").unwrap();
    assert!(matches!(
        snapshot_connection(
            &source,
            &target,
            &SnapshotOptions::default(),
            &SnapshotControl::with_timeout(Duration::from_secs(1))
        ),
        Err(SnapshotError::UnsafePath)
    ));
    assert_eq!(fs::read(target).unwrap(), b"working-database");
    assert_eq!(fs::read(wal).unwrap(), b"working-wal");
    assert_no_partials(directory.path());
}
