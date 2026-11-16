//! Actual Vault/admission coordinator; no child process or network is used.
use super::*;
use crate::runtime::profile::{ProfileRuntimeLeases, StartupMode};
use taomni_plugin_api::services::OperationId;
use taomni_plugin_services::OperationKind;

const PASSWORD: &str = "qa-original-master";
const NEW_PASSWORD: &str = "qa-replacement-master";

struct Harness {
    registry: PluginRegistry,
    services: Arc<PluginCoreServices>,
    vault: Arc<Vault>,
    _root: tempfile::TempDir,
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
        Self {
            registry,
            services,
            vault,
            _root: root,
        }
    }
    fn initialize(&self) {
        self.registry
            .initialize_vault(&self.vault, PASSWORD)
            .unwrap();
        assert_eq!(self.services.admission.state(), AdmissionState::Open);
    }
}

#[test]
fn only_successful_password_verification_opens_production_admission() {
    let h = Harness::new();
    assert!(h.registry.initialize_vault(&h.vault, "short").is_err());
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    h.initialize();
    h.registry.lock_vault(&h.vault).unwrap();
    assert_eq!(h.vault.status().unwrap().state, VaultStateKind::Locked);
    assert_eq!(
        h.registry
            .unlock_vault(&h.vault, "wrong-password")
            .unwrap_err(),
        crate::vault::ERR_VAULT_BAD_PASSWORD
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    h.registry.unlock_vault(&h.vault, PASSWORD).unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
}

#[test]
fn failed_drain_stays_closed_preserves_root_and_retries_the_same_revocation() {
    let h = Harness::new();
    h.initialize();
    let permit = h
        .services
        .admission
        .admit_core_until(
            OperationId::parse(uuid::Uuid::new_v4().to_string()).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&h.services.root).unwrap(),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    assert!(
        h.registry
            .lock_vault_until(&h.vault, Instant::now() + Duration::from_millis(20))
            .is_err()
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    assert_eq!(h.vault.status().unwrap().state, VaultStateKind::Unlocked);
    assert!(permit.check_current().is_err());
    let revocation = h.services.vault_transition.lock().unwrap().clone().unwrap();
    drop(permit);
    h.registry.lock_vault(&h.vault).unwrap();
    assert!(h.services.vault_transition.lock().unwrap().is_none());
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    assert_eq!(h.vault.status().unwrap().state, VaultStateKind::Locked);
    assert!(h.services.admission.finish_revoke(&revocation).is_err());
    h.registry.unlock_vault(&h.vault, PASSWORD).unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
}

#[test]
fn rekey_waits_for_the_external_operation_lease_and_retry_preserves_data() {
    let h = Harness::new();
    h.initialize();
    let reference = h
        .vault
        .put("test", "retained", "retained-plaintext")
        .unwrap()
        .reference;
    let other = VaultOperationLease::try_read(&h.services.root).unwrap();
    assert!(
        h.registry
            .vault_action(
                &h.vault,
                Action::ChangeMaster(PASSWORD, NEW_PASSWORD),
                Instant::now() + Duration::from_millis(20)
            )
            .is_err()
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    drop(other);
    h.registry
        .change_vault_master(&h.vault, PASSWORD, NEW_PASSWORD)
        .unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert_eq!(
        h.vault.resolve(&reference).unwrap().unwrap().as_str(),
        "retained-plaintext"
    );
    h.registry.lock_vault(&h.vault).unwrap();
    assert!(h.registry.unlock_vault(&h.vault, PASSWORD).is_err());
    h.registry.unlock_vault(&h.vault, NEW_PASSWORD).unwrap();
    assert_eq!(
        h.vault.resolve(&reference).unwrap().unwrap().as_str(),
        "retained-plaintext"
    );
}

#[test]
fn a_bad_rekey_password_preserves_the_existing_current_unlock() {
    let h = Harness::new();
    h.initialize();
    assert_eq!(
        h.registry
            .change_vault_master(&h.vault, "wrong-password", NEW_PASSWORD)
            .unwrap_err(),
        crate::vault::ERR_VAULT_BAD_PASSWORD
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert_eq!(h.vault.status().unwrap().state, VaultStateKind::Unlocked);
    h.registry.lock_vault(&h.vault).unwrap();
    h.registry.unlock_vault(&h.vault, PASSWORD).unwrap();
}

#[test]
fn restore_password_verification_uses_the_transition_barrier_and_retains_its_errors() {
    let h = Harness::new();
    h.registry.verify_restore_password(&h.vault, None).unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    h.initialize();
    h.registry.lock_vault(&h.vault).unwrap();
    assert_eq!(
        h.registry
            .verify_restore_password(&h.vault, None)
            .unwrap_err(),
        crate::vault::ERR_VAULT_PASSWORD_REQUIRED
    );
    assert_eq!(
        h.registry
            .verify_restore_password(&h.vault, Some("wrong-password"))
            .unwrap_err(),
        crate::vault::ERR_VAULT_BAD_PASSWORD
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    h.registry
        .verify_restore_password(&h.vault, Some(PASSWORD))
        .unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert!(h.vault.cached_root_is_current().unwrap());
}

#[test]
fn nested_quiescence_drains_core_credentials_and_resumes_only_after_the_last_guard() {
    let h = Harness::new();
    h.initialize();
    let saved = h
        .vault
        .put("test", "retained", "retained-plaintext")
        .unwrap();
    let first = h.registry.quiesce().unwrap();
    let second = h.registry.quiesce().unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    assert!(h.vault.cached_root_is_current().unwrap());
    assert_eq!(
        h.vault.resolve(&saved.reference).unwrap_err(),
        crate::vault::ERR_VAULT_LOCKED
    );
    drop(first);
    assert_eq!(
        h.vault.resolve(&saved.reference).unwrap_err(),
        crate::vault::ERR_VAULT_LOCKED
    );
    drop(second);
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert_eq!(
        h.vault.resolve(&saved.reference).unwrap().unwrap().as_str(),
        "retained-plaintext"
    );
    let guard = h.registry.quiesce().unwrap();
    h.registry.shutdown().unwrap();
    drop(guard);
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    assert!(!h.vault.cached_root_is_current().unwrap());
}

#[test]
fn shutdown_keeps_the_root_until_core_operations_drain_and_retry_clears_it() {
    let h = Harness::new();
    h.initialize();
    let permit = h
        .registry
        .admit_core_operation(
            OperationKind::ReadData,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    assert!(
        h.registry
            .shutdown_until(Instant::now() + Duration::from_millis(20))
            .is_err()
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    assert!(h.vault.cached_root_is_current().unwrap());
    assert!(permit.check_current().is_err());
    assert!(!h.registry.shutting_down.load(Ordering::Acquire));
    drop(permit);
    h.registry.shutdown().unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    assert!(!h.vault.cached_root_is_current().unwrap());
}
