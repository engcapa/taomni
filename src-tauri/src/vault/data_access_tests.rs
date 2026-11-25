//! Ordinary public credential APIs, production admission and real local files.
use super::*;
use crate::{
    plugin::{PluginRegistry, services::PluginCoreServices},
    runtime::profile::{ProfileRuntimeLeases, StartupMode},
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use taomni_plugin_services::AdmissionState;
use taomni_profile_locks::{ProfileRoot, VaultOperationLease};

const PASSWORD: &str = "qa-original-master";
const NEW_PASSWORD: &str = "qa-replacement-master";

struct Harness {
    registry: PluginRegistry,
    services: Arc<PluginCoreServices>,
    vault: Arc<Vault>,
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
        registry.initialize_vault(&vault, PASSWORD).unwrap();
        Self {
            registry,
            services,
            vault,
            root,
        }
    }
}

#[test]
fn ordinary_writes_are_admitted_before_the_vault_mutex_and_cannot_outlive_lock() {
    let h = Harness::new();
    let root = ProfileRoot::prepare(h.root.path()).unwrap();
    let inner = h.vault.inner.lock().unwrap();
    let task = {
        let vault = h.vault.clone();
        std::thread::spawn(move || vault.put("ssh", "late write", "must-not-persist"))
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    // Lease acquisition precedes admission. Observing only the file lock
    // could let revocation win before registration while this test holds the
    // Vault mutex, so wait for the actual operation too.
    while h.services.admission.in_flight_count() == 0 {
        assert!(
            Instant::now() < deadline,
            "credential write never registered its outer operation"
        );
        std::thread::yield_now();
    }
    assert!(VaultOperationLease::try_write(&root).is_err());
    assert!(
        h.registry
            .lock_vault_until(&h.vault, Instant::now() + Duration::from_millis(20))
            .is_err()
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    assert!(inner.root_key.is_some());
    drop(inner);
    assert_eq!(task.join().unwrap().unwrap_err(), ERR_VAULT_LOCKED);
    h.registry.lock_vault(&h.vault).unwrap();
    h.registry.unlock_vault(&h.vault, PASSWORD).unwrap();
    assert!(h.vault.list().unwrap().is_empty());
}

#[test]
fn external_rekey_rejects_ordinary_reads_and_writes_without_corrupting_entries() {
    let h = Harness::new();
    let saved = h.vault.put("ssh", "retained", "retained-secret").unwrap();
    let root = ProfileRoot::prepare(h.root.path()).unwrap();
    let other = Vault::open(&h.root.path().join("vault.db")).unwrap();
    let lease = VaultOperationLease::try_write(&root).unwrap();
    other.change_master(PASSWORD, NEW_PASSWORD).unwrap();
    drop(lease);
    assert_eq!(
        h.vault
            .put("mail", "stale", "must-not-persist")
            .unwrap_err(),
        ERR_VAULT_LOCKED
    );
    assert_eq!(
        h.vault.resolve(&saved.reference).unwrap_err(),
        ERR_VAULT_LOCKED
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    assert!(h.vault.inner.lock().unwrap().root_key.is_none());
    assert_eq!(h.vault.list().unwrap().len(), 1);
    h.registry.unlock_vault(&h.vault, NEW_PASSWORD).unwrap();
    assert_eq!(
        h.vault.resolve(&saved.reference).unwrap().unwrap().as_str(),
        "retained-secret"
    );
    h.vault.update(&saved.id, "updated-secret").unwrap();
    assert_eq!(
        h.vault.resolve(&saved.reference).unwrap().unwrap().as_str(),
        "updated-secret"
    );
}

#[test]
fn locked_metadata_and_plaintext_compatibility_do_not_bypass_sensitive_admission() {
    let h = Harness::new();
    let saved = h.vault.put("git", "retained", "retained-secret").unwrap();
    h.registry.lock_vault(&h.vault).unwrap();
    assert_eq!(h.vault.list().unwrap().len(), 1);
    assert!(h.vault.resolve("legacy-plaintext").unwrap().is_none());
    assert_eq!(h.vault.get_fixed(&saved.id).unwrap_err(), ERR_VAULT_LOCKED);
    assert_eq!(
        h.vault.update(&saved.id, "must-not-persist").unwrap_err(),
        ERR_VAULT_LOCKED
    );
    assert_eq!(
        h.vault
            .put_fixed("new-fixed", "test", "new", "secret")
            .unwrap_err(),
        ERR_VAULT_LOCKED
    );
    h.vault.delete(&saved.id).unwrap();
    assert!(h.vault.list().unwrap().is_empty());
}

#[test]
fn reverse_key_service_detects_external_rekey_and_closes_the_production_epoch() {
    use std::collections::BTreeSet;
    use taomni_plugin_api::{
        RequestId,
        services::{
            FIXED_KEY_SERVICE, FixedKeyAction, FixedKeyId, FixedKeyRequest, HostInstanceId,
            MFA_DATA_KEY_ID, OperationId,
        },
    };
    use taomni_plugin_services::{OperationKind, VerifiedHostGrants};
    use taomni_profile_locks::PluginSlug;

    let h = Harness::new();
    let root = ProfileRoot::prepare(h.root.path()).unwrap();
    let other = Vault::open(&h.root.path().join("vault.db")).unwrap();
    let lease = VaultOperationLease::try_write(&root).unwrap();
    other.change_master(PASSWORD, NEW_PASSWORD).unwrap();
    drop(lease);
    let host = VerifiedHostGrants::from_verified_manifest(
        PluginSlug::parse("mfa").unwrap(),
        BTreeSet::from([FIXED_KEY_SERVICE.into()]),
        BTreeSet::from([MFA_DATA_KEY_ID.into()]),
    )
    .unwrap()
    .bind_authenticated_transport(HostInstanceId::parse(uuid::Uuid::new_v4().to_string()).unwrap());
    let operation = h
        .services
        .admission
        .admit_until(
            &host,
            OperationId::parse(uuid::Uuid::new_v4().to_string()).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            Instant::now() + Duration::from_secs(3),
        )
        .unwrap();
    let borrowed = h
        .services
        .admission
        .borrow_operation(&host, operation.context())
        .unwrap();
    let id = RequestId::from("key-after-rekey");
    let request = borrowed.begin_service_request(id.clone()).unwrap();
    let error = h
        .vault
        .plugin_fixed_key_frame(
            id,
            FixedKeyRequest {
                key_id: FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap(),
                action: FixedKeyAction::Load,
            },
            request,
        )
        .err()
        .unwrap();
    assert_eq!(error, plugin_access::PluginKeyError::VaultLocked);
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    assert!(operation.check_current().is_err());
    assert!(h.vault.inner.lock().unwrap().root_key.is_none());
    let revocation = h
        .services
        .admission
        .begin_or_join_revoke(&[host.clone()])
        .unwrap();
    assert!(
        h.services
            .admission
            .host_revoke_pending(&host, &revocation)
            .unwrap()
    );
    drop(borrowed);
    drop(operation);
    // A service error is not a host's key-clear or kernel termination receipt.
    assert!(h.services.admission.finish_revoke(&revocation).is_err());
}
