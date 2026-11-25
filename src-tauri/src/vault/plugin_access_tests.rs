//! Real Vault/crypto/SQLite tests. The core must include plugin_access before
//! running these on the hosted candidate; no copied Vault implementation.
use std::collections::BTreeSet;

use taomni_plugin_api::{RequestId, services::*};
use taomni_plugin_services::*;
use taomni_profile_locks::*;

use super::*;

const HOST: &str = "a1234567-1234-1234-1234-123456789abc";
const GRANT: &str = "c1234567-1234-1234-1234-123456789abc";

struct Harness {
    _directory: tempfile::TempDir,
    root: ProfileRoot,
    vault: Vault,
    host: AuthorizedHost,
    admission: OperationAdmission,
    next_operation: std::sync::atomic::AtomicU64,
}

impl Harness {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(directory.path()).unwrap();
        let vault = Vault::open(&root.path().join("vault.db")).unwrap();
        vault.init("plugin-test-master").unwrap();
        let host = VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("mfa").unwrap(),
            BTreeSet::from([FIXED_KEY_SERVICE.into()]),
            BTreeSet::from([MFA_DATA_KEY_ID.into()]),
        )
        .unwrap()
        .bind_authenticated_transport(HostInstanceId::parse(HOST).unwrap());
        let admission = OperationAdmission::new(
            ProfileGeneration::parse(HOST).unwrap(),
            VaultEpoch::new(1).unwrap(),
            false,
        );
        Self {
            _directory: directory,
            root,
            vault,
            host,
            admission,
            next_operation: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn operation(&self, kind: OperationKind) -> OperationPermit {
        let lease = if kind.requires_exclusive_lease() {
            VaultOperationLease::try_write(&self.root)
        } else {
            VaultOperationLease::try_read(&self.root)
        }
        .unwrap();
        let operation = format!(
            "b1234567-1234-1234-1234-{:012x}",
            self.next_operation
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        self.admission
            .admit(
                &self.host,
                OperationId::parse(operation).unwrap(),
                kind,
                lease,
            )
            .unwrap()
    }

    fn request(
        &self,
        operation: &OperationPermit,
        action: FixedKeyAction,
    ) -> Result<FixedKeyResult, PluginKeyError> {
        let borrowed = self
            .admission
            .borrow_operation(&self.host, operation.context())
            .unwrap();
        let permit = borrowed
            .begin_service_request(RequestId::from("host-key-1"))
            .unwrap();
        let frame = self.vault.plugin_fixed_key_frame(
            RequestId::from("host-key-1"),
            FixedKeyRequest {
                key_id: FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap(),
                action,
            },
            permit,
        )?;
        #[derive(serde::Deserialize)]
        struct Reply {
            result: FixedKeyResult,
        }
        Ok(
            serde_json::from_slice::<Reply>(frame.current_bytes().unwrap())
                .unwrap()
                .result,
        )
    }
}

#[test]
fn reads_the_old_fixed_key_without_changing_its_bytes() {
    let harness = Harness::new();
    harness
        .vault
        .put_fixed(
            MFA_DATA_KEY_ID,
            "mfa_secret",
            "MFA Data Key",
            &STANDARD.encode([9u8; 32]),
        )
        .unwrap();
    let operation = harness.operation(OperationKind::ReadData);
    let FixedKeyResult::Key { key, .. } =
        harness.request(&operation, FixedKeyAction::Load).unwrap()
    else {
        panic!("missing key");
    };
    assert_eq!(key.as_bytes(), &[9; 32]);
}

#[test]
fn missing_key_load_does_not_create_and_read_cannot_initialize() {
    let harness = Harness::new();
    let operation = harness.operation(OperationKind::ReadData);
    assert!(matches!(
        harness.request(&operation, FixedKeyAction::Load).unwrap(),
        FixedKeyResult::Missing
    ));
    drop(operation);
    assert!(harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().is_none());
    let operation = harness.operation(OperationKind::ReadData);
    assert_eq!(
        harness
            .request(&operation, FixedKeyAction::CreateIfAbsent)
            .err()
            .map(|error| error.to_string())
            .as_deref(),
        Some("PERMISSION_DENIED")
    );
}

#[test]
fn initialization_preserves_existing_key_and_reset_alone_can_repair_corruption() {
    let harness = Harness::new();
    harness
        .vault
        .put_fixed(MFA_DATA_KEY_ID, "mfa_secret", "MFA Data Key", "broken")
        .unwrap();
    let init = harness.operation(OperationKind::InitializeEmptyStore);
    assert_eq!(
        harness
            .request(&init, FixedKeyAction::CreateIfAbsent)
            .err()
            .map(|error| error.to_string())
            .as_deref(),
        Some("MFA_KEY_MISMATCH")
    );
    drop(init);
    let reset = harness.operation(OperationKind::ResetStore);
    let grant = ResetGrantId::parse(GRANT).unwrap();
    reset.grant_reset(grant.clone()).unwrap();
    assert!(matches!(
        harness
            .request(&reset, FixedKeyAction::RepairEmptyAfterReset { grant })
            .unwrap(),
        FixedKeyResult::Key { .. }
    ));
    drop(reset);
    let old = harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().unwrap();
    let init = harness.operation(OperationKind::InitializeEmptyStore);
    harness
        .request(&init, FixedKeyAction::CreateIfAbsent)
        .unwrap();
    assert_eq!(
        harness
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str(),
        old.as_str()
    );
}

#[test]
fn locked_or_cross_process_rekeyed_vault_never_creates_a_new_key() {
    let harness = Harness::new();
    harness.vault.lock().unwrap();
    let operation = harness.operation(OperationKind::InitializeEmptyStore);
    assert_eq!(
        harness
            .request(&operation, FixedKeyAction::CreateIfAbsent)
            .err()
            .map(|error| error.to_string())
            .as_deref(),
        Some("VAULT_LOCKED")
    );
    drop(operation);
    harness.vault.unlock("plugin-test-master").unwrap();
    let other = Vault::open(&harness.root.path().join("vault.db")).unwrap();
    other.unlock("plugin-test-master").unwrap();
    other
        .change_master("plugin-test-master", "changed-master")
        .unwrap();
    let operation = harness.operation(OperationKind::ReadData);
    assert_eq!(
        harness
            .request(&operation, FixedKeyAction::Load)
            .err()
            .map(|error| error.to_string())
            .as_deref(),
        Some("VAULT_LOCKED")
    );
    drop(operation);
    harness.vault.unlock("changed-master").unwrap();
    assert!(harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().is_none());
}
