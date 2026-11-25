use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use rusqlite::Connection;
use serde_json::json;
use taomni_profile_locks::{LegacyUpgradeLease, ProfileRoot, ProfileUseLease};
use taomni_sqlite_snapshot::{
    SnapshotControl, SnapshotError, SnapshotObserver, SnapshotPhase, SnapshotProgress,
};

use super::{
    migration::{export::PreparedMfaExport, inspect_legacy_install},
    support::*,
};

#[test]
#[ignore = "real SQLite, files and OS leases run only on GitHub"]
fn changed_mfa_or_vault_preflight_is_rejected_and_a_fresh_attempt_can_retry() {
    for relative in ["mfa.db", "vault.db"] {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        if relative == "mfa.db" {
            fixture
                .mfa
                .execute("UPDATE mfa_accounts SET note='committed newer source'", [])
                .unwrap();
        } else {
            fixture
                .vault
                .execute("UPDATE vault_entries SET ciphertext=X'05060708'", [])
                .unwrap();
        }
        let error = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control())
            .err()
            .unwrap();
        assert!(error.contains("source changed"), "{error}");
        fixture.assert_no_staging();
        let prepared =
            PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &control()).unwrap();
        prepared.verify().unwrap();
        drop(prepared);
        fixture.assert_no_staging();
    }
    evidence(
        "mfa-export-stale-source",
        &json!({"mfa_and_vault_rejected": true, "fresh_retry_succeeded": true}),
    );
}

#[test]
#[ignore = "real SQLite, files and OS leases run only on GitHub"]
fn source_changes_during_snapshot_discard_the_artifact_before_handoff() {
    for relative in ["mfa.db", "vault.db"] {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        let path = fixture.root.path().join(relative);
        let control = OnceAt::control(SnapshotPhase::Starting, move || {
            let writer = Connection::open(path).unwrap();
            let sql = if relative == "mfa.db" {
                "UPDATE mfa_accounts SET note='writer raced export'"
            } else {
                "UPDATE vault_entries SET ciphertext=X'10111213'"
            };
            writer.execute(sql, []).unwrap();
        });
        let error = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control)
            .err()
            .unwrap();
        assert!(error.contains("source changed"), "{error}");
        fixture.assert_no_staging();
        assert!(LegacyUpgradeLease::try_acquire(&fixture.root).is_ok());
        assert!(ProfileUseLease::try_acquire(&fixture.root).is_ok());
    }
    evidence(
        "mfa-export-racing-writer",
        &json!({"both_sources_rechecked_after_real_snapshot": true, "temporary_data_removed": true}),
    );
}

struct CancelAt {
    phase: SnapshotPhase,
    cancelled: AtomicBool,
}
impl SnapshotObserver for CancelAt {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn progress(&self, progress: SnapshotProgress) {
        if progress.phase == self.phase {
            self.cancelled.store(true, Ordering::Release);
        }
    }
}

#[test]
#[ignore = "real SQLite, files and OS leases run only on GitHub"]
fn cancellation_and_deadline_release_ownership_and_never_replace_working_data() {
    for phase in [SnapshotPhase::Verifying, SnapshotPhase::Completed] {
        let fixture = Fixture::new();
        let before = fixture.bytes();
        let existing = fixture.root.path().join("plugins/mfa/data/mfa.db");
        fs::create_dir_all(existing.parent().unwrap()).unwrap();
        fs::write(&existing, b"working-artifact").unwrap();
        let control = SnapshotControl::new(
            Instant::now() + Duration::from_secs(10),
            Arc::new(CancelAt {
                phase,
                cancelled: AtomicBool::new(false),
            }),
        );
        let error = PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &control)
            .err()
            .unwrap();
        assert_eq!(error, SnapshotError::Cancelled.to_string());
        unchanged(&before);
        assert_eq!(fs::read(&existing).unwrap(), b"working-artifact");
        fixture.assert_no_staging();
        let expired = SnapshotControl::with_timeout(Duration::ZERO);
        assert_eq!(
            PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &expired)
                .err()
                .unwrap(),
            SnapshotError::TimedOut.to_string()
        );
        let prepared = PreparedMfaExport::prepare(
            &fixture.root,
            &fixture.snapshot(),
            &super::support::control(),
        )
        .unwrap();
        prepared.verify().unwrap();
        drop(prepared);
        fixture.assert_no_staging();
        assert!(ProfileUseLease::try_acquire(&fixture.root).is_ok());
    }
    evidence(
        "mfa-export-cancel",
        &json!({"before_and_after_snapshot_publication_cancelled": true, "deadline_enforced": true, "working_data_unchanged": true, "retry_succeeded": true}),
    );
}

#[test]
#[ignore = "real SQLite, files and OS leases run only on GitHub"]
fn modified_snapshot_receipt_sidecar_or_source_cannot_pass_handoff_verification() {
    for kind in [
        "database",
        "receipt",
        "sidecar",
        "mfa-source",
        "vault-source",
    ] {
        let fixture = Fixture::new();
        let prepared =
            PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &control()).unwrap();
        let path = prepared.database_path().unwrap();
        match kind {
            "database" => fs::write(&path, b"altered export").unwrap(),
            "receipt" => fs::write(path.parent().unwrap().join("receipt.json"), b"{}").unwrap(),
            "sidecar" => fs::write(path.with_file_name("mfa.db-wal"), []).unwrap(),
            "mfa-source" => {
                fixture
                    .mfa
                    .execute("UPDATE mfa_accounts SET counter=1", [])
                    .unwrap();
            }
            "vault-source" => {
                fixture
                    .vault
                    .execute("UPDATE vault_entries SET ciphertext=X'FF'", [])
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(prepared.verify().is_err(), "accepted changed {kind}");
        drop(prepared);
        assert!(!path.exists());
        fixture.assert_no_staging();
    }
    evidence(
        "mfa-export-handoff-recheck",
        &json!({"database_receipt_sidecar_and_both_sources_rejected": true}),
    );
}

#[test]
#[ignore = "real SQLite, files and OS leases run only on GitHub"]
fn invalid_database_and_disappeared_inputs_leave_no_usable_export() {
    let directory = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(directory.path()).unwrap();
    let path = root.path().join("mfa.db");
    fs::write(&path, b"not a SQLite database").unwrap();
    let snapshot = inspect_legacy_install(root.path(), "0.5.9").unwrap();
    let error = PreparedMfaExport::prepare(&root, &snapshot, &control())
        .err()
        .unwrap();
    assert!(
        error.contains("database") || error.contains("SQLite"),
        "{error}"
    );
    assert!(
        fs::read_dir(root.path().join("migration/exports"))
            .unwrap()
            .next()
            .is_none()
    );
    fs::remove_file(&path).unwrap();
    assert!(
        PreparedMfaExport::prepare(&root, &snapshot, &control())
            .err()
            .unwrap()
            .contains("source changed")
    );
    assert!(!path.exists());
    assert!(!root.path().join("plugins").exists());
    evidence(
        "mfa-export-invalid-source",
        &json!({"invalid_and_missing_source_rejected": true, "no_replacement_or_initialization": true}),
    );
}
