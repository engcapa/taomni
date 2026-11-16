use super::{protected_snapshot, range::resolve_scope_flags, snapshot_context::SnapshotContext};
use crate::{
    mfa::{
        crypto,
        store::{self, MfaAccountInput, MfaStore},
    },
    plugin::test_services::{PASSWORD, VaultHarness},
    vault::{MFA_DATA_KEY_ENTRY_ID, MfaKeyAction, Vault},
};
use base64::Engine;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use taomni_plugin_services::{AdmissionState, OperationKind};
use zeroize::Zeroizing;

pub(super) fn seed_hotp(h: &VaultHarness, mfa: &MfaStore) -> Vec<u8> {
    let permit = h
        .registry
        .admit_core_operation(
            OperationKind::InitializeEmptyStore,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    let key = h
        .vault
        .mfa_key_with_permit(&permit, MfaKeyAction::InitializeEmpty)
        .unwrap()
        .unwrap();
    let key = Zeroizing::new(*key.as_bytes());
    mfa.with_conn(|conn| {
        let input = store::validate_input(&MfaAccountInput {
            issuer: "Snapshot RFC4226".into(),
            account_name: "qa".into(),
            secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into(),
            kind: "hotp".into(),
            algorithm: "SHA1".into(),
            digits: 6,
            period: 30,
            counter: 0,
            group: String::new(),
            note: String::new(),
        })?;
        store::insert_account(conn, &key, &input)?;
        // A persisted v1 key-check fixture, independent of the snapshot code.
        let (sealed, mut nonce) =
            crypto::seal(&key, b"taomni-mfa:key-check", b"taomni-mfa-key-check-v1")?;
        nonce.extend(sealed);
        store::meta_set(conn, "key_check", &nonce)?;
        Ok(nonce)
    })
    .unwrap()
}

fn staged_path<'a>(files: &'a [super::engine::StagedFile], path: &str) -> &'a Path {
    files
        .iter()
        .find(|file| file.archive_path == path)
        .unwrap()
        .disk_path
        .as_path()
}

#[test]
fn locked_pair_retains_rekeyed_vault_key_check_and_real_hotp() {
    let h = VaultHarness::new();
    h.initialize();
    let mfa = MfaStore::new(h.root.path().join("mfa.db"));
    let key_check = seed_hotp(&h, &mfa);
    h.registry
        .change_vault_master(&h.vault, PASSWORD, "qa-rekeyed-snapshot-master")
        .unwrap();
    h.registry.lock_vault(&h.vault).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let files = protected_snapshot::stage(
        &h.registry,
        &h.vault,
        &mfa,
        staging.path(),
        resolve_scope_flags("core", None),
        &SnapshotContext::default(),
    )
    .unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    let restored_vault =
        Vault::open(&staged_path(&files, "databases/vault.db").to_path_buf()).unwrap();
    assert!(restored_vault.unlock(PASSWORD).is_err());
    restored_vault.unlock("qa-rekeyed-snapshot-master").unwrap();
    let stored = restored_vault
        .get_fixed(MFA_DATA_KEY_ENTRY_ID)
        .unwrap()
        .unwrap();
    let bytes = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(stored.as_bytes())
            .unwrap(),
    );
    let key = Zeroizing::new(bytes.as_slice().try_into().unwrap());
    let restored = rusqlite::Connection::open_with_flags(
        staged_path(&files, "databases/mfa.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        store::meta_get(&restored, "key_check").unwrap().unwrap(),
        key_check
    );
    let rows = store::list_sealed(&restored).unwrap();
    assert_eq!(rows.len(), 1);
    let secret = store::open_secret(&key, &rows[0]).unwrap();
    assert_eq!(store::code_for(&rows[0].account, &secret, 0).code, "755224");
    assert_eq!(rows[0].account.counter, 0);
}

#[test]
fn unused_mfa_snapshot_does_not_create_a_business_database_or_fixed_key() {
    let h = VaultHarness::new();
    h.initialize();
    let mfa = MfaStore::new(h.root.path().join("mfa.db"));
    let staging = tempfile::tempdir().unwrap();
    let files = protected_snapshot::stage(
        &h.registry,
        &h.vault,
        &mfa,
        staging.path(),
        resolve_scope_flags("core", None),
        &SnapshotContext::default(),
    )
    .unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].archive_path, "databases/vault.db");
    assert!(!mfa.path().exists());
    assert!(h.vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().is_none());
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
}

#[test]
fn unopened_existing_store_includes_wal_without_initializing_its_schema() {
    let h = VaultHarness::new();
    let source = h.root.path().join("mfa.db");
    let writer = rusqlite::Connection::open(&source).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE legacy_marker(value); INSERT INTO legacy_marker VALUES('committed WAL');").unwrap();
    let before = std::fs::read(&source).unwrap();
    let wal = std::fs::read(source.with_file_name("mfa.db-wal")).unwrap();
    let mfa = MfaStore::new(source.clone());
    let staging = tempfile::tempdir().unwrap();
    let files = protected_snapshot::stage(
        &h.registry,
        &h.vault,
        &mfa,
        staging.path(),
        resolve_scope_flags("core", None),
        &SnapshotContext::default(),
    )
    .unwrap();
    let snapshot = rusqlite::Connection::open(staged_path(&files, "databases/mfa.db")).unwrap();
    let marker: String = snapshot
        .query_row("SELECT value FROM legacy_marker", [], |r| r.get(0))
        .unwrap();
    assert_eq!(marker, "committed WAL");
    for conn in [&writer, &snapshot] {
        let initialized: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='mfa_accounts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(initialized, 0, "backup must not migrate the source");
    }
    assert_eq!(std::fs::read(&source).unwrap(), before);
    assert_eq!(
        std::fs::read(source.with_file_name("mfa.db-wal")).unwrap(),
        wal
    );
}

#[test]
fn damaged_source_removes_staging_and_restores_ordinary_admission() {
    let h = VaultHarness::new();
    h.initialize();
    let saved = h.vault.put("test", "retained", "retained-secret").unwrap();
    let mfa = MfaStore::new(h.root.path().join("mfa.db"));
    std::fs::write(mfa.path(), b"damaged sqlite fixture").unwrap();
    let staging = tempfile::tempdir().unwrap();
    assert!(
        protected_snapshot::stage(
            &h.registry,
            &h.vault,
            &mfa,
            staging.path(),
            resolve_scope_flags("core", None),
            &SnapshotContext::default(),
        )
        .is_err()
    );
    assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
    assert_eq!(
        std::fs::read(mfa.path()).unwrap(),
        b"damaged sqlite fixture"
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert_eq!(
        h.vault.resolve(&saved.reference).unwrap().unwrap().as_str(),
        "retained-secret"
    );
}

#[test]
fn pre_cancelled_snapshot_leaves_staging_and_source_untouched() {
    let h = VaultHarness::new();
    let mfa = MfaStore::new(h.root.path().join("mfa.db"));
    let staging = tempfile::tempdir().unwrap();
    let context = SnapshotContext::default();
    context.cancel.cancel();
    assert_eq!(
        protected_snapshot::stage(
            &h.registry,
            &h.vault,
            &mfa,
            staging.path(),
            resolve_scope_flags("core", None),
            &context,
        )
        .unwrap_err(),
        "BACKUP_CANCELLED"
    );
    assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
    assert!(!mfa.path().exists());
}
