use std::{
    fs,
    sync::{Arc, atomic::Ordering},
};

use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use taomni_mfa_engine::keys::ExistingKeyCheck;
use taomni_profile_locks::{
    LegacyUpgradeLease, PluginDataLease, PluginSlug, ProfileRestoreLease, VaultOperationLease,
};

use super::{
    plugin::migration::export::PreparedMfaExport, support::*,
    vault::migration_check::MfaMigrationKeyCheck,
};

#[test]
#[ignore = "actual encrypted Vault/WAL and MFA files run only on GitHub"]
fn real_vault_key_checks_bound_and_unbound_exports_without_writing_any_source() {
    for bound in [false, true] {
        let fixture = Fixture::new(bound);
        let snapshot = fixture.snapshot();
        let before = fixture.bytes();
        let prepared = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control()).unwrap();
        let path = prepared.database_path().unwrap();
        let exported = fs::read(&path).unwrap();
        assert_eq!(
            prepared.verify_key(MASTER).unwrap(),
            MfaMigrationKeyCheck::Database(ExistingKeyCheck::Verified {
                accounts: 1,
                key_check_present: bound
            })
        );
        let connection =
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            taomni_mfa_engine::operations::codes(
                &connection,
                &zeroize::Zeroizing::new(MFA_KEY),
                None,
                0
            )
            .unwrap()[0]
                .code,
            "755224"
        );
        assert_eq!(
            prepared.verify_key(MASTER.trim()).unwrap_err(),
            "VAULT_BAD_PASSWORD"
        );
        assert!(LegacyUpgradeLease::try_acquire(&fixture.root).is_err());
        assert!(ProfileRestoreLease::try_acquire(&fixture.root).is_err());
        assert!(VaultOperationLease::try_read(&fixture.root).is_err());
        assert!(
            PluginDataLease::try_acquire(&fixture.root, &PluginSlug::parse("mfa").unwrap())
                .is_err()
        );
        prepared.verify().unwrap();
        assert_eq!(fs::read(&path).unwrap(), exported);
        unchanged(&before);
        drop(connection);
        drop(prepared);
        fixture.assert_no_staging();
    }
    evidence(
        "real-vault-success",
        json!({"bound_and_unbound":true,"original_hotp":true,"original_password_bytes_required":true,"all_source_bytes_unchanged":true,"snapshot_unchanged":true,"unrelated_corrupt_secret_ignored":true,"maintenance_leases_retained":true,"cleanup_complete":true}),
    );
}

#[test]
#[ignore = "actual encrypted Vault password/key failures run only on GitHub"]
fn wrong_password_and_missing_or_corrupt_fixed_keys_never_repair_or_activate() {
    for mutation in [
        None,
        Some("DELETE FROM vault_entries WHERE id='mfa.data-key-v1'"),
        Some("UPDATE vault_entries SET nonce=x'01' WHERE id='mfa.data-key-v1'"),
    ] {
        let fixture = Fixture::new(true);
        if let Some(sql) = mutation {
            fixture.vault.execute(sql, []).unwrap();
        }
        let before = fixture.bytes();
        let prepared =
            PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &control()).unwrap();
        let path = prepared.database_path().unwrap();
        let exported = fs::read(&path).unwrap();
        let expected = match mutation {
            None => "VAULT_BAD_PASSWORD",
            Some(sql) if sql.starts_with("DELETE") => "MFA_KEY_MISSING",
            _ => "MFA_KEY_MISMATCH",
        };
        let password = if mutation.is_none() {
            "wrong-password"
        } else {
            MASTER
        };
        assert_eq!(prepared.verify_key(password).unwrap_err(), expected);
        if mutation.is_none() {
            assert_eq!(
                prepared.verify_key("").unwrap_err(),
                "VAULT_PASSWORD_REQUIRED"
            );
            assert!(prepared.verify_key(MASTER).is_ok());
        }
        assert_eq!(fs::read(&path).unwrap(), exported);
        unchanged(&before);
        assert!(!fixture.root.path().join("plugins/mfa").exists());
        assert!(!fixture.root.path().join("migration/journal.json").exists());
        prepared.verify().unwrap();
        drop(prepared);
        fixture.assert_no_staging();
    }
    evidence(
        "real-vault-failures",
        json!({"bad_and_empty_password_rejected":true,"missing_and_corrupt_key_rejected":true,"correct_password_retry":true,"no_key_or_database_repair":true,"no_activation_or_journal_commit":true,"all_source_bytes_unchanged":true,"snapshot_unchanged":true}),
    );
}

#[test]
#[ignore = "retained key-only Vault files run only on GitHub"]
fn key_only_input_checks_the_original_vault_key_without_manufacturing_a_database() {
    let fixture = Fixture::new(true);
    let Fixture {
        root,
        mfa,
        vault,
        _directory,
    } = fixture;
    drop(mfa);
    fs::remove_file(root.path().join("mfa.db")).unwrap();
    let main_before = fs::read(root.path().join("vault.db")).unwrap();
    let wal_before = fs::read(root.path().join("vault.db-wal")).unwrap();
    let snapshot = super::plugin::migration::inspect_legacy_install(root.path(), "0.5.9").unwrap();
    let prepared = PreparedMfaExport::prepare(&root, &snapshot, &control()).unwrap();
    assert!(prepared.database_path().is_none());
    assert_eq!(
        prepared.verify_key(MASTER).unwrap(),
        MfaMigrationKeyCheck::VaultKeyOnly
    );
    assert_eq!(
        prepared.verify_key("bad").unwrap_err(),
        "VAULT_BAD_PASSWORD"
    );
    assert!(!root.path().join("mfa.db").exists());
    assert!(!root.path().join("plugins/mfa/data/mfa.db").exists());
    assert_eq!(fs::read(root.path().join("vault.db")).unwrap(), main_before);
    assert_eq!(
        fs::read(root.path().join("vault.db-wal")).unwrap(),
        wal_before
    );
    prepared.verify().unwrap();
    drop(prepared);
    drop(vault);
    evidence(
        "real-vault-key-only",
        json!({"original_key_verified":true,"wrong_password_rejected":true,"no_database_created":true,"vault_main_and_wal_unchanged":true}),
    );
}

#[test]
#[ignore = "actual file cancellation and changed-source rejection run only on GitHub"]
fn cancellation_and_vault_changes_refuse_key_handoff_and_release_for_retry() {
    let fixture = Fixture::new(true);
    let before = fixture.bytes();
    let cancel = Arc::new(Cancel::default());
    let prepared =
        PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &cancel.control()).unwrap();
    cancel.0.store(true, Ordering::Release);
    assert_eq!(prepared.verify_key(MASTER).unwrap_err(), "BACKUP_CANCELLED");
    unchanged(&before);
    drop(prepared);
    fixture.assert_no_staging();
    let prepared =
        PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &control()).unwrap();
    fixture
        .vault
        .execute(
            "UPDATE vault_entries SET updated_at=updated_at+1 WHERE id='mfa.data-key-v1'",
            [],
        )
        .unwrap();
    let changed = fixture.bytes();
    assert!(
        prepared
            .verify_key(MASTER)
            .unwrap_err()
            .contains("source changed")
    );
    unchanged(&changed);
    drop(prepared);
    fixture.assert_no_staging();
    let retry = PreparedMfaExport::prepare(&fixture.root, &fixture.snapshot(), &control()).unwrap();
    assert!(retry.verify_key(MASTER).is_ok());
    unchanged(&changed);
    drop(retry);
    fixture.assert_no_staging();
    evidence(
        "real-vault-cancel-source-change",
        json!({"cancelled_before_key_access":true,"source_change_rejected":true,"refreshed_retry_succeeds":true,"sources_unchanged_by_check":true,"cleanup_complete":true}),
    );
}
