//! Real production coordinator/Vault/MFA, in one process with isolated files.
use super::{
    access, crypto,
    store::{self, MfaAccountInput, MfaStore},
};
use crate::{
    plugin::{PluginRegistry, services::PluginCoreServices},
    runtime::profile::{ProfileRuntimeLeases, StartupMode},
    vault::{MFA_DATA_KEY_ENTRY_ID, MfaKeyAction, Vault, VaultStateKind},
};
use std::{
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};
use taomni_plugin_services::{AdmissionState, OperationKind};
use taomni_profile_locks::{ProfileRoot, VaultOperationLease};

const PASSWORD: &str = "qa-current-master";
const NEW_PASSWORD: &str = "qa-replacement-master";

struct Harness {
    registry: PluginRegistry,
    services: Arc<PluginCoreServices>,
    vault: Arc<Vault>,
    mfa: MfaStore,
    root: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile =
            Arc::new(ProfileRuntimeLeases::acquire(root.path(), StartupMode::Desktop).unwrap());
        let vault = Arc::new(Vault::open(&root.path().join("vault.db")).unwrap());
        let services =
            Arc::new(PluginCoreServices::new(root.path(), vault.clone(), profile).unwrap());
        let registry = PluginRegistry::with_services(root.path().join("plugins"), services.clone());
        let mfa = MfaStore::new(root.path().join("mfa.db"));
        Self {
            registry,
            services,
            vault,
            mfa,
            root,
        }
    }
    fn init(&self) {
        self.registry
            .initialize_vault(&self.vault, PASSWORD)
            .unwrap();
    }
    fn add(&self) -> String {
        access::with_key(
            &self.registry,
            &self.vault,
            &self.mfa,
            OperationKind::WriteData,
            |conn, key| {
                let input = store::validate_input(&MfaAccountInput {
                    issuer: "Retained".into(),
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
                Ok(store::insert_account(conn, key, &input)?.id)
            },
        )
        .unwrap()
    }
    fn code(&self) -> Result<String, String> {
        access::with_key(
            &self.registry,
            &self.vault,
            &self.mfa,
            OperationKind::ReadData,
            |conn, key| {
                let sealed = store::list_sealed(conn)?.remove(0);
                let secret = store::open_secret(key, &sealed)?;
                Ok(store::code_for(&sealed.account, &secret, 0).code)
            },
        )
    }
    fn short_deadline(&self) -> Instant {
        Instant::now() + Duration::from_millis(30)
    }
}

#[test]
fn locked_access_does_not_create_mfa_db_and_normal_access_uses_shared_lease() {
    let h = Harness::new();
    assert_eq!(h.code().unwrap_err(), crate::vault::ERR_VAULT_LOCKED);
    assert!(!h.root.path().join("mfa.db").exists());
    h.init();
    h.add();
    let key = h.vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().unwrap();
    let root = ProfileRoot::prepare(h.root.path()).unwrap();
    let other_reader = VaultOperationLease::try_read(&root).unwrap();
    assert_eq!(h.code().unwrap(), "755224");
    assert_eq!(
        h.vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().unwrap(),
        key
    );
    drop(other_reader);
}

#[test]
fn first_empty_initialization_drops_shared_lease_before_waiting_for_exclusive() {
    let h = Harness::new();
    h.init();
    let root = ProfileRoot::prepare(h.root.path()).unwrap();
    let other_reader = VaultOperationLease::try_read(&root).unwrap();
    let run = || {
        access::with_key_until(
            &h.registry,
            &h.vault,
            &h.mfa,
            OperationKind::ReadData,
            h.short_deadline(),
            |conn, _| store::count_accounts(conn),
        )
    };
    assert!(run().is_err());
    assert!(h.vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().is_none());
    assert!(
        h.mfa
            .with_conn(|conn| store::meta_get(conn, "key_check"))
            .unwrap()
            .is_none()
    );
    drop(other_reader);
    assert_eq!(run().unwrap(), 0);
    assert!(h.vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().is_some());
    assert!(VaultOperationLease::try_write(&root).is_ok());
}

#[test]
fn lock_invalidates_a_running_operation_and_retry_drains_before_clearing_root() {
    let h = Arc::new(Harness::new());
    h.init();
    h.add();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let task = {
        let h = h.clone();
        std::thread::spawn(move || {
            access::with_key(
                &h.registry,
                &h.vault,
                &h.mfa,
                OperationKind::ReadData,
                |_, _| {
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok("late-sensitive-code")
                },
            )
        })
    };
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        h.registry
            .lock_vault_until(&h.vault, h.short_deadline())
            .is_err()
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    assert_eq!(h.vault.status().unwrap().state, VaultStateKind::Unlocked);
    release_tx.send(()).unwrap();
    assert_eq!(
        task.join().unwrap().unwrap_err(),
        crate::vault::ERR_VAULT_LOCKED
    );
    h.registry.lock_vault(&h.vault).unwrap();
    assert_eq!(h.vault.status().unwrap().state, VaultStateKind::Locked);
    h.registry.unlock_vault(&h.vault, PASSWORD).unwrap();
    assert_eq!(h.code().unwrap(), "755224");
}

#[test]
fn external_rekey_clears_cached_root_closes_admission_and_allows_verified_retry() {
    let h = Harness::new();
    h.init();
    h.add();
    let root = ProfileRoot::prepare(h.root.path()).unwrap();
    let other = Vault::open(&h.root.path().join("vault.db")).unwrap();
    let exclusive = VaultOperationLease::try_write(&root).unwrap();
    other.change_master(PASSWORD, NEW_PASSWORD).unwrap();
    drop(exclusive);
    assert_eq!(h.code().unwrap_err(), crate::vault::ERR_VAULT_LOCKED);
    assert_eq!(h.vault.status().unwrap().state, VaultStateKind::Locked);
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    h.registry.unlock_vault(&h.vault, NEW_PASSWORD).unwrap();
    assert_eq!(h.code().unwrap(), "755224");
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
}

#[test]
fn ordinary_permits_cannot_create_or_repair_fixed_keys() {
    let h = Harness::new();
    h.init();
    let permit = h
        .registry
        .admit_core_operation(
            OperationKind::ReadData,
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
    for action in [
        MfaKeyAction::InitializeEmpty,
        MfaKeyAction::RepairAfterReset,
    ] {
        assert!(h.vault.mfa_key_with_permit(&permit, action).is_err());
    }
    assert!(h.vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().is_none());
    assert!(
        h.vault
            .verify_export_password_with_permit(PASSWORD, &permit)
            .is_err()
    );
    drop(permit);
    h.add();
    let retained = h.vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().unwrap();
    assert_eq!(
        h.vault
            .update(MFA_DATA_KEY_ENTRY_ID, "replacement")
            .unwrap_err(),
        crate::vault::ERR_VAULT_ENTRY_PROTECTED
    );
    assert_eq!(
        h.vault.delete(MFA_DATA_KEY_ENTRY_ID).unwrap_err(),
        crate::vault::ERR_VAULT_ENTRY_PROTECTED
    );
    assert_eq!(
        h.vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().unwrap(),
        retained
    );
    assert_eq!(h.code().unwrap(), "755224");
}

#[test]
fn reset_is_explicit_exclusive_and_locked_or_busy_attempts_preserve_accounts() {
    let h = Harness::new();
    h.init();
    h.add();
    h.registry.lock_vault(&h.vault).unwrap();
    assert_eq!(
        access::reset_store(&h.registry, &h.vault, &h.mfa).unwrap_err(),
        crate::vault::ERR_VAULT_LOCKED
    );
    assert_eq!(
        h.mfa.with_conn(|conn| store::count_accounts(conn)).unwrap(),
        1
    );
    h.registry.unlock_vault(&h.vault, PASSWORD).unwrap();
    let root = ProfileRoot::prepare(h.root.path()).unwrap();
    let other_reader = VaultOperationLease::try_read(&root).unwrap();
    assert!(access::reset_store_until(&h.registry, &h.vault, &h.mfa, h.short_deadline()).is_err());
    assert_eq!(
        h.mfa.with_conn(|conn| store::count_accounts(conn)).unwrap(),
        1
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    drop(other_reader);
    access::reset_store(&h.registry, &h.vault, &h.mfa).unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert_eq!(
        h.mfa.with_conn(|conn| store::count_accounts(conn)).unwrap(),
        0
    );
    h.add();
    h.vault
        .put_fixed(
            MFA_DATA_KEY_ENTRY_ID,
            crypto::KEY_KIND,
            crypto::KEY_LABEL,
            "malformed-key",
        )
        .unwrap();
    assert_eq!(h.code().unwrap_err(), super::ERR_KEY_MISMATCH);
    assert_eq!(
        h.mfa.with_conn(|conn| store::count_accounts(conn)).unwrap(),
        1
    );
    access::reset_store(&h.registry, &h.vault, &h.mfa).unwrap();
    h.add();
    assert_eq!(h.code().unwrap(), "755224");
}
