use std::{any::Any, fs};

use serde_json::json;
use taomni_profile_locks::{
    PluginDataLease, PluginSlug, ProfileStateLease, ProfileUseLease, VaultOperationLease,
};

use super::{migration::export::PreparedMfaExport, support::*};

#[test]
#[ignore = "real files and OS leases run only on GitHub"]
fn legacy_desktop_and_current_profile_vault_data_state_owners_all_block_export() {
    for owner in ["legacy-mode", "profile", "vault", "mfa", "state"] {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        let before = fixture.bytes();
        let lease: Box<dyn Any> = match owner {
            "legacy-mode" => {
                let file = fs::OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(fixture.root.path().join(".mobile-mode.lock"))
                    .unwrap();
                file.try_lock_shared().unwrap();
                Box::new(file)
            }
            "profile" => Box::new(ProfileUseLease::try_acquire(&fixture.root).unwrap()),
            "vault" => Box::new(VaultOperationLease::try_read(&fixture.root).unwrap()),
            "mfa" => Box::new(
                PluginDataLease::try_acquire(&fixture.root, &PluginSlug::parse("mfa").unwrap())
                    .unwrap(),
            ),
            "state" => Box::new(ProfileStateLease::try_acquire(&fixture.root).unwrap()),
            _ => unreachable!(),
        };
        let error = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control())
            .err()
            .unwrap();
        assert!(error.contains("in use"), "{owner}: {error}");
        unchanged(&before);
        fixture.assert_no_staging();
        drop(lease);
        let prepared = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control()).unwrap();
        prepared.verify().unwrap();
        drop(prepared);
        fixture.assert_no_staging();
    }
    evidence(
        "mfa-export-ownership",
        &json!({"legacy_profile_vault_data_and_state_blocked": true, "release_allows_retry": true}),
    );
}

#[test]
#[ignore = "real files and OS leases run only on GitHub"]
fn another_profiles_snapshot_cannot_borrow_maintenance_authority() {
    let first = Fixture::new();
    let second = Fixture::new();
    let _first_user = ProfileUseLease::try_acquire(&first.root).unwrap();
    let error = PreparedMfaExport::prepare(&second.root, &first.snapshot(), &control())
        .err()
        .unwrap();
    assert!(error.contains("different profile"), "{error}");
    first.assert_no_staging();
    second.assert_no_staging();
    assert!(ProfileUseLease::try_acquire(&second.root).is_ok());
    evidence(
        "mfa-export-profile-binding",
        &json!({"cross_profile_evidence_rejected": true}),
    );
}

#[cfg(unix)]
#[test]
#[ignore = "real linked files and OS leases run only on GitHub"]
fn linked_database_sidecars_and_staging_parents_are_rejected_before_external_writes() {
    for relative in [
        "mfa.db",
        "mfa.db-wal",
        "mfa.db-shm",
        "mfa.db-journal",
        "vault.db",
        "vault.db-wal",
        "vault.db-shm",
        "vault.db-journal",
        "migration",
        "migration/exports",
    ] {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        let outside = tempfile::tempdir().unwrap();
        let marker = outside.path().join("outside-marker");
        fs::write(&marker, b"must-not-be-read-or-replaced").unwrap();
        let path = fixture.root.path().join(relative);
        let target = if relative.starts_with("migration") {
            outside.path()
        } else {
            &marker
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
        std::os::unix::fs::symlink(target, &path).unwrap();
        assert!(
            PreparedMfaExport::prepare(&fixture.root, &snapshot, &control()).is_err(),
            "accepted {relative}"
        );
        assert_eq!(fs::read(&marker).unwrap(), b"must-not-be-read-or-replaced");
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }
    evidence(
        "mfa-export-link-rejection",
        &json!({"unix_main_sidecar_and_staging_links_rejected": 10, "outside_directory_unchanged": true}),
    );
}

#[cfg(unix)]
#[test]
#[ignore = "real hard links and OS leases run only on GitHub"]
fn hard_linked_source_cannot_be_exported_under_another_file_identity() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let outside = tempfile::tempdir().unwrap();
    fs::hard_link(
        fixture.root.path().join("mfa.db"),
        outside.path().join("alias.db"),
    )
    .unwrap();
    let error = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control())
        .err()
        .unwrap();
    assert!(error.contains("hard linked"), "{error}");
    fixture.assert_no_staging();
    evidence(
        "mfa-export-hardlink-rejection",
        &json!({"unix_hard_linked_source_rejected": true}),
    );
}

#[cfg(windows)]
#[test]
#[ignore = "real Windows junction and OS leases run only on GitHub"]
fn windows_junction_staging_root_cannot_redirect_export_to_another_directory() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    let marker = outside.path().join("outside-marker");
    fs::write(&marker, b"outside-original").unwrap();
    let junction = fixture.root.path().join("migration");
    let result = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "could not create the real junction fixture"
    );
    assert!(PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &control()).is_err());
    assert_eq!(fs::read(&marker).unwrap(), b"outside-original");
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    fs::remove_dir(junction).unwrap();
    evidence(
        "mfa-export-junction-rejection",
        &json!({"windows_reparse_staging_parent_rejected": true}),
    );
}
