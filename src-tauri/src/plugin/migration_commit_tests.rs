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

#[path = "migration_backup_mfa_tests.rs"]
mod mfa_backup;
#[path = "migration_execute_mfa_tests.rs"]
mod offline;
#[path = "migration_restore_mfa_tests.rs"]
mod restored_mfa;

const MASTER: &str = "qa legacy migration master";
const CHILD_ROOT: &str = "TAOMNI_QA_MFA_CRASH_PROFILE";
const EXIT_DURING_ACTIVATION: i32 = 73;

#[test]
#[ignore = "the offline process, original Vault and signed module run only on GitHub"]
fn signed_legacy_mfa_offline_maintenance_starts_without_a_journal_and_retries_safely() {
    offline::exercise_maintenance_process();
}

#[test]
#[ignore = "a production-signed MFA process verifies the restored profile on GitHub"]
fn signed_legacy_mfa_backup_restores_into_a_new_profile() {
    restored_mfa::exercise_modular_restore();
}

#[test]
#[ignore = "the active signed host and Vault are snapshotted and restored on GitHub"]
fn signed_legacy_mfa_running_host_backup_restores_original_vault_and_counter() {
    mfa_backup::exercise_round_trip(mfa_backup::MfaState::Running);
}

#[test]
#[ignore = "disabled signed host data is snapshotted and restored on GitHub"]
fn signed_legacy_mfa_disabled_module_backup_preserves_disabled_preference() {
    mfa_backup::exercise_round_trip(mfa_backup::MfaState::Disabled);
}

#[test]
#[ignore = "uninstalled signed host data is snapshotted and restored on GitHub"]
fn signed_legacy_mfa_uninstalled_module_backup_restores_data_without_code() {
    mfa_backup::exercise_round_trip(mfa_backup::MfaState::Uninstalled);
}

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
    interrupted_migration_can_retry(false);
}

#[test]
#[ignore = "real preinstalled signed package, abrupt child exit and boot recovery run only on GitHub"]
fn signed_legacy_mfa_restart_preserves_preinstalled_module_and_disabled_preference() {
    interrupted_migration_can_retry(true);
}

fn interrupted_migration_can_retry(preinstalled: bool) {
    let legacy = Legacy::new();
    let root = legacy.root.path();
    let package = InstalledMfa::verified_package();
    let original_pointer = preinstalled.then(|| {
        let registry = crate::plugin::PluginRegistry::new(root.join("plugins"));
        registry.install_verified(&package).unwrap();
        registry.set_enabled(OWNER, false).unwrap();
        fs::read(root.join(POINTER)).unwrap()
    });
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
    assert!(!root.join(TARGET).exists() && !root.join(PLAN).exists());
    assert_eq!(fs::read(root.join(POINTER)).ok(), original_pointer);
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
    commit(legacy.prepare(), &package, MASTER).unwrap();
    if let Some(pointer) = original_pointer {
        assert_eq!(fs::read(root.join(POINTER)).unwrap(), pointer);
        assert_eq!(read_registry_state(root).unwrap().get(OWNER), Some(&false));
    }
    assert_ne!(generation::current(root).unwrap(), staged_generation);
    assert!(
        MigrationJournal::load(&root.join(JOURNAL))
            .unwrap()
            .committed(MigrationItem::Mfa)
    );
    legacy.assert_legacy_intact();
}

#[test]
#[ignore = "the production facade uses the actual signed MFA host and files on GitHub"]
fn signed_legacy_mfa_facade_keeps_exclusive_ownership_after_migration() {
    use crate::{ai::config::AiConfig, mfa::backend, runtime::bootstrap::isolated_state};

    let legacy = Legacy::new();
    let root = legacy.root.path();
    let package = InstalledMfa::verified_package();
    commit(legacy.prepare(), &package, MASTER).unwrap();
    let state = isolated_state(root, AiConfig::default()).unwrap();
    assert!(state.legacy.mfa.legacy_store().unwrap().is_none());
    state.plugins.set_enabled(OWNER, true).unwrap();
    let original_mfa = fs::read(root.join("mfa.db")).unwrap();

    let list = || {
        tauri::async_runtime::block_on(backend::run(
            &state,
            "mfa_list",
            OperationKind::ReadData,
            (),
            |_| json!({}),
            |_, _, ()| -> Result<mfa::models::MfaSnapshot, String> {
                panic!("committed MFA must never reopen its legacy store")
            },
        ))
    };
    let export = |password: &str| {
        tauri::async_runtime::block_on(backend::export(
            &state,
            legacy.account_id.clone(),
            Zeroizing::new(password.into()),
        ))
    };
    assert_eq!(list().unwrap_err(), "VAULT_LOCKED");
    state
        .plugins
        .unlock_vault(&state.core.vault, MASTER)
        .unwrap();
    let listed = list().unwrap();
    assert_eq!(listed.accounts[0].id, legacy.account_id);
    assert_eq!(listed.accounts[0].issuer, "original issuer");
    assert_eq!(export("wrong-password").unwrap_err(), "VAULT_BAD_PASSWORD");
    let uri = Zeroizing::new(export(MASTER).unwrap());
    assert!(uri.starts_with("otpauth://hotp/") && uri.contains("counter=0"));
    state.plugins.set_enabled(OWNER, false).unwrap();
    assert_eq!(list().unwrap_err(), "plugin mfa is disabled");
    state.plugins.set_enabled(OWNER, true).unwrap();

    tauri::async_runtime::block_on(backend::reset(&state)).unwrap();
    assert!(list().unwrap().accounts.is_empty());
    assert_eq!(export(MASTER).unwrap_err(), "MFA_NOT_FOUND");
    assert_eq!(fs::read(root.join("mfa.db")).unwrap(), original_mfa);
    state.plugins.uninstall(OWNER, false).unwrap();
    assert!(list().is_err());
    assert!(state.legacy.mfa.legacy_store().unwrap().is_none());
    assert_eq!(fs::read(root.join("mfa.db")).unwrap(), original_mfa);
    state.plugins.shutdown().unwrap();
}

#[test]
#[ignore = "legacy archive restore and signed host are exercised on GitHub"]
fn signed_legacy_mfa_restore_uses_module_data_after_normal_profile_startup() {
    use crate::{
        ai::config::AiConfig,
        backup::{
            engine::{StagedFile, pack_staged_archive},
            restore::stage_restore_to_dir,
        },
        mfa::backend,
        runtime::bootstrap::isolated_state,
    };

    let legacy = Legacy::new();
    let root = legacy.root.path();
    let archive = root.join("legacy-mfa.taobak");
    pack_staged_archive(
        &["mfa.db", "vault.db"].map(|name| StagedFile {
            archive_path: format!("databases/{name}"),
            disk_path: root.join(name),
        }),
        "0.5.9",
        "core",
        None,
        &archive,
    )
    .unwrap();
    commit(legacy.prepare(), &InstalledMfa::verified_package(), MASTER).unwrap();
    let active = root.join("plugins/mfa/active.json");
    let original_active = fs::read(&active).unwrap();
    let original_mfa = fs::read(root.join("mfa.db")).unwrap();
    {
        let mut db = mfa::store::open_db(&root.join(TARGET)).unwrap();
        let key = Zeroizing::new([37_u8; 32]);
        assert_eq!(
            mfa::operations::hotp_next(&mut db, &key, &legacy.account_id)
                .unwrap()
                .code,
            "287082"
        );
    }
    let before_restore = generation::current(root).unwrap();
    assert!(
        stage_restore_to_dir(root, &archive, None)
            .unwrap()
            .restart_required
    );
    assert_eq!(generation::current(root).unwrap(), before_restore);

    let state = isolated_state(root, AiConfig::default()).unwrap();
    assert!(state.legacy.mfa.legacy_store().unwrap().is_none());
    assert_ne!(generation::current(root).unwrap(), before_restore);
    assert_eq!(fs::read(&active).unwrap(), original_active);
    assert_eq!(fs::read(root.join("mfa.db")).unwrap(), original_mfa);
    assert_eq!(
        fs::read(root.join("lanchat.sqlite")).unwrap(),
        legacy.source_bytes[2]
    );
    let locator = crate::plugin::retained_data::load(&root.join("plugins"), OWNER)
        .unwrap()
        .unwrap();
    assert_eq!(locator.files[0].path, "mfa.db");
    assert_eq!(locator.data_schema_version, 1);
    state.plugins.set_enabled(OWNER, true).unwrap();
    state
        .plugins
        .unlock_vault(&state.core.vault, MASTER)
        .unwrap();
    let codes = tauri::async_runtime::block_on(backend::run(
        &state,
        "mfa_codes",
        OperationKind::ReadData,
        (),
        |_| json!({}),
        |_, _, ()| -> Result<Vec<mfa::models::MfaCode>, String> {
            panic!("restoring an old backup must keep the module data owner")
        },
    ))
    .unwrap();
    assert_eq!(codes.len(), 1);
    assert_eq!(codes[0].id, legacy.account_id);
    assert_eq!(codes[0].code, "755224");
    state.plugins.shutdown().unwrap();
}

#[test]
fn interrupted_mfa_activation_child() {
    let Some(path) = std::env::var_os(CHILD_ROOT) else {
        return;
    };
    let profile = ProfileRoot::prepare(&PathBuf::from(path)).unwrap();
    let package = InstalledMfa::verified_package();
    commit_inner(prepare(&profile), &package, MASTER, None, || {
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
