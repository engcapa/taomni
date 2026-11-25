//! Actual persisted Vault, actual MFA executable and production core pump.
//! This does not stand in for signed installation or legacy upgrade acceptance.
use crate::{
    plugin::host::{
        HostProcess, HostProcessError, HostProfileConfig, HostServiceConfig, HostSupervisorConfig,
    },
    vault::Vault,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use taomni_plugin_api::services::*;
use taomni_plugin_services::*;
use taomni_profile_locks::*;

const ID: &str = "a1234567-1234-1234-1234-123456789abc";
const MASTER: &str = "actual-mfa-host-master";
const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

struct Harness {
    process: HostProcess,
    vault: Arc<Vault>,
    admission: OperationAdmission,
    root: ProfileRoot,
    sequence: u64,
    _dir: tempfile::TempDir,
}
impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(dir.path()).unwrap();
        let generation = crate::runtime::generation::current(root.path()).unwrap();
        let vault = Arc::new(Vault::open(&root.path().join("vault.db")).unwrap());
        vault.init(MASTER).unwrap();
        let admission = OperationAdmission::new(generation, VaultEpoch::new(1).unwrap(), false);
        let process = Self::start(&root, vault.clone(), admission.clone());
        Self {
            process,
            vault,
            admission,
            root,
            sequence: 0,
            _dir: dir,
        }
    }
    fn start(root: &ProfileRoot, vault: Arc<Vault>, admission: OperationAdmission) -> HostProcess {
        let dispatcher = Arc::new(
            CoreServiceDispatcher::new(admission, vault, DispatcherConfig::default()).unwrap(),
        );
        let grants = VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("mfa").unwrap(),
            BTreeSet::from([FIXED_KEY_SERVICE.into()]),
            BTreeSet::from([MFA_DATA_KEY_ID.into()]),
        )
        .unwrap();
        let path = PathBuf::from(
            std::env::var_os("TAOMNI_MFA_PLUGIN_BIN")
                .expect("actual hosted MFA executable required"),
        );
        assert!(path.is_absolute() && path.is_file());
        let manifest: Value =
            serde_json::from_str(include_str!("../../plugins/mfa/module.json")).unwrap();
        let commands = manifest["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let generation = crate::runtime::generation::current(root.path()).unwrap();
        let process = HostProcess::start_profiled(
            HostProfileConfig::new(root.clone(), PluginSlug::parse("mfa").unwrap(), generation),
            "taomni-plugin-mfa",
            "0.1.0",
            &path,
            path.parent().unwrap(),
            &commands,
            &[FIXED_KEY_SERVICE.into()],
            HostSupervisorConfig {
                request_timeout: Duration::from_secs(10),
                heartbeat_timeout: Duration::from_secs(2),
                ..Default::default()
            },
            Some(HostServiceConfig { dispatcher, grants }),
        )
        .unwrap();
        assert!(ProfileRestoreLease::try_acquire(root).is_err());
        assert!(PluginDataLease::try_acquire(root, &PluginSlug::parse("mfa").unwrap()).is_err());
        process
    }
    fn permit(&mut self, kind: OperationKind) -> OperationPermit {
        self.sequence += 1;
        let lease = if kind.requires_exclusive_lease() {
            VaultOperationLease::try_write(&self.root)
        } else {
            VaultOperationLease::try_read(&self.root)
        }
        .unwrap();
        self.admission
            .admit_until(
                self.process.authorized_host().unwrap(),
                OperationId::parse(format!("d1234567-1234-1234-1234-{:012x}", self.sequence))
                    .unwrap(),
                kind,
                lease,
                Instant::now() + Duration::from_secs(10),
            )
            .unwrap()
    }
    fn call(
        &mut self,
        kind: OperationKind,
        method: &str,
        payload: Option<Value>,
    ) -> Result<Value, HostProcessError> {
        let permit = self.permit(kind);
        self.process.invoke_with_operation(permit, method, payload)
    }
    fn add(&mut self) -> String {
        let value = self.call(OperationKind::WriteData, "mfa_add", Some(json!({"inputs":[{"issuer":"RFC","accountName":"qa@example.com","kind":"hotp","secret":SECRET}],"skipDuplicates":false}))).unwrap();
        value["added"][0]["id"].as_str().unwrap().to_owned()
    }
    fn code(&mut self) -> Value {
        self.call(OperationKind::ReadData, "mfa_codes", None)
            .unwrap()[0]
            .clone()
    }
    fn restart(&mut self) {
        self.process
            .stop_confirmed(Instant::now() + Duration::from_secs(10))
            .unwrap();
        self.process = Self::start(&self.root, self.vault.clone(), self.admission.clone());
    }
}

#[test]
#[ignore = "actual Vault/MFA process: execute only on GitHub runners"]
fn actual_mfa_host_preserves_existing_vault_key_and_hotp_across_restart_and_rekey() {
    let mut harness = Harness::new();
    let old = STANDARD.encode([91; 32]);
    harness
        .vault
        .put_fixed(MFA_DATA_KEY_ID, "mfa_secret", "MFA Data Key", &old)
        .unwrap();
    let id = harness.add();
    assert_eq!(harness.code()["code"], "755224");
    harness
        .call(
            OperationKind::WriteData,
            "mfa_hotp_next",
            Some(json!({"id":id})),
        )
        .unwrap();
    harness.restart();
    assert_eq!(harness.code()["counter"], 1);
    assert_eq!(harness.code()["code"], "287082");
    assert_eq!(
        harness
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str(),
        old
    );
    // No admitted operations remain. Persisted re-encryption preserves the
    // plugin data key; full registry rekey coordination has separate gates.
    harness
        .vault
        .change_master(MASTER, "new-actual-mfa-master")
        .unwrap();
    assert_eq!(harness.code()["code"], "287082");
    harness.vault.lock().unwrap();
    assert!(
        harness
            .call(OperationKind::ReadData, "mfa_codes", None)
            .unwrap_err()
            .to_string()
            .contains("VAULT_LOCKED")
    );
    harness.vault.unlock("new-actual-mfa-master").unwrap();
    assert_eq!(harness.code()["code"], "287082");
    assert_eq!(
        harness
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str(),
        old
    );
}

#[test]
#[ignore = "actual Vault/MFA process: execute only on GitHub runners"]
fn actual_empty_host_only_creates_a_protected_key_under_exclusive_initialization() {
    let mut harness = Harness::new();
    assert!(
        harness
            .call(OperationKind::ReadData, "mfa_list", None)
            .unwrap_err()
            .to_string()
            .contains("MFA_INITIALIZATION_REQUIRED")
    );
    assert!(harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().is_none());
    assert_eq!(
        harness
            .call(OperationKind::ReadData, "mfa_initialize_empty", None)
            .unwrap_err()
            .rpc_code(),
        -32004
    );
    assert!(harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().is_none());
    harness
        .call(
            OperationKind::InitializeEmptyStore,
            "mfa_initialize_empty",
            None,
        )
        .unwrap();
    let key = harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().unwrap();
    assert_eq!(STANDARD.decode(key.as_str()).unwrap().len(), 32);
    let id = harness.add();
    let grant = ExportGrantId::parse(ID).unwrap();
    let payload = json!({"id":id,"grant":grant});
    assert!(
        harness
            .call(
                OperationKind::ExportSecret,
                "mfa_export_uri",
                Some(payload.clone())
            )
            .is_err()
    );
    let permit = harness.permit(OperationKind::ExportSecret);
    assert!(
        harness
            .vault
            .verify_master_password(Some("wrong-master"))
            .is_err()
    );
    assert!(harness.vault.verify_master_password(Some("")).is_err());
    harness.vault.verify_master_password(Some(MASTER)).unwrap();
    permit.grant_export_after_verified_password(grant).unwrap();
    let uri = harness
        .process
        .invoke_with_operation(permit, "mfa_export_uri", Some(payload.clone()))
        .unwrap();
    assert!(uri.as_str().unwrap().contains(SECRET));
    assert!(
        harness
            .call(OperationKind::ExportSecret, "mfa_export_uri", Some(payload))
            .is_err()
    );
    assert_eq!(
        harness
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str(),
        key.as_str()
    );
}

#[test]
#[ignore = "actual Vault/MFA process: execute only on GitHub runners"]
fn actual_malformed_vault_entry_is_repaired_only_by_the_explicit_reset_grant() {
    let mut harness = Harness::new();
    harness
        .call(
            OperationKind::InitializeEmptyStore,
            "mfa_initialize_empty",
            None,
        )
        .unwrap();
    let id = harness.add();
    let old = harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().unwrap();
    harness
        .vault
        .put_fixed(MFA_DATA_KEY_ID, "mfa_secret", "MFA Data Key", "malformed")
        .unwrap();
    assert!(
        harness
            .call(OperationKind::ReadData, "mfa_codes", None)
            .unwrap_err()
            .to_string()
            .contains("MFA_KEY_MISMATCH")
    );
    assert!(
        harness
            .call(
                OperationKind::InitializeEmptyStore,
                "mfa_initialize_empty",
                None
            )
            .is_err()
    );
    assert!(
        harness
            .call(
                OperationKind::ResetStore,
                "mfa_reset_store",
                Some(json!({"grant":ID}))
            )
            .is_err()
    );
    assert_eq!(
        harness
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str(),
        "malformed"
    );
    harness
        .vault
        .put_fixed(MFA_DATA_KEY_ID, "mfa_secret", "MFA Data Key", old.as_str())
        .unwrap();
    assert_eq!(
        harness
            .call(OperationKind::ReadData, "mfa_list", None)
            .unwrap()["accounts"][0]["id"],
        id
    );
    harness
        .vault
        .put_fixed(MFA_DATA_KEY_ID, "mfa_secret", "MFA Data Key", "malformed")
        .unwrap();
    let permit = harness.permit(OperationKind::ResetStore);
    permit
        .grant_reset(ResetGrantId::parse(ID).unwrap())
        .unwrap();
    harness
        .process
        .invoke_with_operation(permit, "mfa_reset_store", Some(json!({"grant":ID})))
        .unwrap();
    assert_ne!(
        harness
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str(),
        old.as_str()
    );
    assert!(
        harness
            .call(OperationKind::ReadData, "mfa_list", None)
            .unwrap()["accounts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    harness.restart();
    harness.add();
    assert_eq!(harness.code()["code"], "755224");
}
