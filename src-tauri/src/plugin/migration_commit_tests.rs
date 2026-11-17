//! Production trust anchor, original Vault and actual installed host.
use std::{path::PathBuf, process::Command, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::json;
use taomni_mfa_engine::{self as mfa, models::MfaAccountInput};
use taomni_plugin_services::OperationKind;
use taomni_sqlite_snapshot::SnapshotControl;
use zeroize::Zeroizing;

use super::*;
use crate::{
    plugin::{
        migration::{MigrationExecutor, inspect_legacy_install},
        signed_mfa_host_tests::support::InstalledMfa,
        test_services::VaultHarness,
    },
    runtime::profile::{ProfileRuntimeLeases, StartupMode},
    vault::Vault,
};

const MASTER: &str = "qa legacy migration master";
const CHILD_ROOT: &str = "TAOMNI_QA_MFA_CRASH_PROFILE";
const EXIT_DURING_ACTIVATION: i32 = 73;

struct Legacy {
    directory: tempfile::TempDir,
    root: ProfileRoot,
    generation: ProfileGeneration,
    source_bytes: [Vec<u8>; 3],
    account_id: String,
}

impl Legacy {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(directory.path()).unwrap();
        let data = root.path();
        let generation = generation::current(data).unwrap();
        let key = Zeroizing::new([37_u8; 32]);
        {
            let vault = Vault::open(&data.join("vault.db")).unwrap();
            vault.init(MASTER).unwrap();
            vault
                .put_fixed(
                    MFA_DATA_KEY_ID,
                    "mfa_secret",
                    "MFA Data Key",
                    &STANDARD.encode(*key),
                )
                .unwrap();
        }
        let account_id = {
            let mut database = mfa::store::open_db(&data.join("mfa.db")).unwrap();
            mfa::operations::add(
                &mut database,
                &key,
                &[MfaAccountInput {
                    issuer: "original issuer".into(),
                    account_name: "qa@example.com".into(),
                    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into(),
                    kind: "hotp".into(),
                    algorithm: "SHA1".into(),
                    digits: 6,
                    period: 30,
                    counter: 0,
                    group: "original group".into(),
                    note: "original note".into(),
                }],
                false,
            )
            .unwrap()
            .added
            .remove(0)
            .id
        };
        fs::write(data.join("lanchat.sqlite"), b"retained chat").unwrap();
        let snapshot = inspect_legacy_install(data, "0.5.9").unwrap();
        let result = MigrationExecutor::new(
            data,
            data.join("plugins"),
            data.join(JOURNAL),
            "0.5.9",
            CORE_API_VERSION,
        )
        .unwrap()
        .record_pending(&snapshot)
        .unwrap();
        assert_eq!(result.pending, [MigrationItem::Mfa]);
        let source_bytes = file_bytes(data);
        Self {
            directory,
            root,
            generation,
            source_bytes,
            account_id,
        }
    }

    fn assert_legacy_intact(&self) {
        assert_eq!(file_bytes(self.root.path()), self.source_bytes);
    }

    fn prepare(&self) -> PreparedMfaExport {
        prepare(&self.root)
    }
}

fn file_bytes(root: &Path) -> [Vec<u8>; 3] {
    ["mfa.db", "vault.db", "lanchat.sqlite"].map(|name| fs::read(root.join(name)).unwrap())
}

fn prepare(profile: &ProfileRoot) -> PreparedMfaExport {
    let snapshot = inspect_legacy_install(profile.path(), "0.5.9").unwrap();
    PreparedMfaExport::prepare(
        profile,
        &snapshot,
        &SnapshotControl::with_timeout(Duration::from_secs(45)),
    )
    .unwrap()
}

fn invoke(h: &VaultHarness, method: &str) -> serde_json::Value {
    h.registry
        .invoke_scoped(
            OWNER,
            method,
            json!({}),
            &uuid::Uuid::new_v4().to_string(),
            OperationKind::ReadData,
            std::time::Instant::now() + Duration::from_secs(15),
        )
        .unwrap()
}

#[test]
#[ignore = "real signed packages, Vault and spawned host run only on GitHub"]
fn signed_legacy_mfa_commit_preserves_original_journal_and_hotp_on_host_start() {
    let legacy = Legacy::new();
    let package = InstalledMfa::verified_package();
    commit(legacy.prepare(), &package, MASTER).unwrap();
    let root = legacy.root.path();
    legacy.assert_legacy_intact();
    let journal = MigrationJournal::load(&root.join(JOURNAL)).unwrap();
    assert_eq!(journal.status, MigrationRunState::Complete);
    assert!(journal.committed(MigrationItem::Mfa));
    assert_eq!(journal.entries[0].target, Path::new(TARGET));
    let inspect = inspect_legacy_install(root, "0.5.9").unwrap();
    let repeated = MigrationExecutor::new(
        root,
        root.join("plugins"),
        root.join(JOURNAL),
        "0.5.9",
        CORE_API_VERSION,
    )
    .unwrap()
    .record_pending(&inspect)
    .unwrap();
    assert_eq!(repeated.status, MigrationRunState::Complete);
    assert_eq!(repeated.committed, [MigrationItem::Mfa]);
    assert!(repeated.pending.is_empty());
    assert_eq!(
        MigrationJournal::load(&root.join(JOURNAL)).unwrap().entries,
        journal.entries
    );
    assert_ne!(generation::current(root).unwrap(), legacy.generation);
    assert!(!root.join(PLAN).exists());
    assert!(!root.join(DATA_DIR).join(OWNERSHIP).exists());
    assert!(
        fs::read_dir(root.join("migration/exports"))
            .unwrap()
            .next()
            .is_none()
    );

    let h = VaultHarness::open(legacy.directory);
    h.registry.scan().unwrap();
    assert_eq!(&h.registry.get(OWNER).unwrap().manifest, package.manifest());
    h.registry.unlock_vault(&h.vault, MASTER).unwrap();
    h.registry.set_enabled(OWNER, true).unwrap();
    let listed = invoke(&h, "mfa_list");
    let serialized = listed.to_string();
    assert!(serialized.contains(&legacy.account_id));
    assert!(serialized.contains("original issuer") && serialized.contains("original group"));
    let code = invoke(&h, "mfa_codes");
    assert_eq!(code[0]["id"], legacy.account_id);
    assert_eq!(code[0]["code"], "755224");
    h.registry.shutdown().unwrap();
}

#[test]
#[ignore = "real signed package, abrupt child exit and boot recovery run only on GitHub"]
fn signed_legacy_mfa_restart_rolls_back_interrupted_activation_and_allows_retry() {
    let legacy = Legacy::new();
    let root = legacy.root.path();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "plugin::migration_commit::tests::interrupted_mfa_activation_child",
            "--nocapture",
        ])
        .env(CHILD_ROOT, root)
        .output()
        .unwrap();
    assert_eq!(
        child.status.code(),
        Some(EXIT_DURING_ACTIVATION),
        "migration child did not reach the active pointer"
    );
    assert!(
        root.join(TARGET).is_file() && root.join(PLAN).is_file() && root.join(POINTER).is_file()
    );
    let staged_generation = generation::current(root).unwrap();
    assert_ne!(staged_generation, legacy.generation);
    let leases = ProfileRuntimeLeases::acquire(root, StartupMode::Headless).unwrap();
    assert_eq!(leases.generation, staged_generation);
    assert!(
        !root.join(TARGET).exists() && !root.join(PLAN).exists() && !root.join(POINTER).exists()
    );
    assert!(
        fs::read_dir(root.join("migration/exports"))
            .unwrap()
            .next()
            .is_none()
    );
    assert_eq!(
        MigrationJournal::load(&root.join(JOURNAL)).unwrap().status,
        MigrationRunState::Pending
    );
    legacy.assert_legacy_intact();
    drop(leases);
    let package = InstalledMfa::verified_package();
    commit(legacy.prepare(), &package, MASTER).unwrap();
    assert_ne!(generation::current(root).unwrap(), staged_generation);
    assert!(
        MigrationJournal::load(&root.join(JOURNAL))
            .unwrap()
            .committed(MigrationItem::Mfa)
    );
    legacy.assert_legacy_intact();
}

#[test]
fn interrupted_mfa_activation_child() {
    let Some(path) = std::env::var_os(CHILD_ROOT) else {
        return;
    };
    let profile = ProfileRoot::prepare(&PathBuf::from(path)).unwrap();
    let package = InstalledMfa::verified_package();
    commit_inner(prepare(&profile), &package, MASTER, || {
        // A separate process exits without dropping the export or profile leases.
        std::process::exit(EXIT_DURING_ACTIVATION);
    })
    .unwrap();
    panic!("expected to exit before committing the migration journal");
}

#[test]
#[ignore = "real package and data collision tests run only on GitHub"]
fn signed_legacy_mfa_keeps_existing_target_and_pending_state_on_wrong_password_or_conflict() {
    let legacy = Legacy::new();
    let root = legacy.root.path();
    let package = InstalledMfa::verified_package();
    let pending = fs::read(root.join(JOURNAL)).unwrap();
    assert_eq!(
        commit(legacy.prepare(), &package, "wrong").unwrap_err(),
        "VAULT_BAD_PASSWORD"
    );
    assert!(
        !root.join(POINTER).exists() && !root.join(TARGET).exists() && !root.join(PLAN).exists()
    );
    fs::create_dir_all(root.join(DATA_DIR)).unwrap();
    fs::write(root.join(TARGET), b"existing retained data").unwrap();
    let error = commit(legacy.prepare(), &package, MASTER).unwrap_err();
    assert!(error.contains("already has module data"), "{error}");
    assert_eq!(
        fs::read(root.join(TARGET)).unwrap(),
        b"existing retained data"
    );
    assert_eq!(fs::read(root.join(JOURNAL)).unwrap(), pending);
    assert_eq!(generation::current(root).unwrap(), legacy.generation);
    legacy.assert_legacy_intact();
}
