//! Hosted integration links the actual Vault adapter, production host pump and
//! SDK binary. This is a service gate, not a signed/installed MFA migration.
use crate::{
    plugin::host::{HostProcess, HostProfileConfig, HostServiceConfig, HostSupervisorConfig},
    vault::Vault,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use taomni_plugin_api::services::*;
use taomni_plugin_services::*;
use taomni_profile_locks::*;

struct Harness {
    root: ProfileRoot,
    vault: Arc<Vault>,
    admission: OperationAdmission,
    process: HostProcess,
    sequence: u64,
    _dir: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(dir.path()).unwrap();
        let generation = crate::runtime::generation::current(root.path()).unwrap();
        let vault = Arc::new(Vault::open(&dir.path().join("vault.db")).unwrap());
        vault.init("host-gate-master").unwrap();
        let admission =
            OperationAdmission::new(generation.clone(), VaultEpoch::new(1).unwrap(), false);
        let dispatcher = Arc::new(
            CoreServiceDispatcher::new(
                admission.clone(),
                vault.clone(),
                DispatcherConfig::default(),
            )
            .unwrap(),
        );
        let grants = VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("mfa").unwrap(),
            BTreeSet::from([FIXED_KEY_SERVICE.into()]),
            BTreeSet::from([MFA_DATA_KEY_ID.into()]),
        )
        .unwrap();
        let host = PathBuf::from(
            std::env::var_os("TAOMNI_SERVICE_PLUGIN_BIN").expect("hosted SDK fixture is required"),
        );
        assert!(host.is_absolute() && host.is_file());
        let process = HostProcess::start_profiled(
            HostProfileConfig::new(root.clone(), PluginSlug::parse("mfa").unwrap(), generation),
            "taomni-plugin-mfa",
            "0.1.0",
            &host,
            host.parent().unwrap(),
            &[
                "service/probe".into(),
                "service/wait".into(),
                "service/crash".into(),
            ],
            &[FIXED_KEY_SERVICE.into()],
            HostSupervisorConfig {
                request_timeout: Duration::from_secs(5),
                heartbeat_timeout: Duration::from_secs(1),
                ..Default::default()
            },
            Some(HostServiceConfig { dispatcher, grants }),
        )
        .unwrap();
        assert!(ProfileRestoreLease::try_acquire(&root).is_err());
        assert!(PluginDataLease::try_acquire(&root, &PluginSlug::parse("mfa").unwrap()).is_err());
        Self {
            _dir: dir,
            root,
            vault,
            admission,
            process,
            sequence: 0,
        }
    }

    fn probe(
        &mut self,
        kind: OperationKind,
        action: FixedKeyAction,
    ) -> Result<serde_json::Value, crate::plugin::host::HostProcessError> {
        self.sequence += 1;
        let lease = if kind.requires_exclusive_lease() {
            VaultOperationLease::try_write(&self.root)
        } else {
            VaultOperationLease::try_read(&self.root)
        }
        .unwrap();
        let permit = self
            .admission
            .admit_until(
                self.process.authorized_host().unwrap(),
                OperationId::parse(format!("b1234567-1234-1234-1234-{:012x}", self.sequence))
                    .unwrap(),
                kind,
                lease,
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap();
        self.process.invoke_with_operation(
            permit,
            "service/probe",
            Some(serde_json::json!({"action":action})),
        )
    }
}

#[test]
#[ignore = "real Vault/SDK/stdio gate: execute only on GitHub runners"]
fn real_vault_key_reaches_only_the_scoped_sdk_and_preserves_old_bytes() {
    let mut harness = Harness::new();
    harness
        .vault
        .put_fixed(
            MFA_DATA_KEY_ID,
            "mfa_secret",
            "MFA Data Key",
            &STANDARD.encode([91; 32]),
        )
        .unwrap();
    let result = harness
        .probe(OperationKind::ReadData, FixedKeyAction::Load)
        .unwrap();
    assert_eq!(result["present"], true);
    let expected: String = Sha256::digest([91; 32])
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(result["digest"], expected);
    assert_eq!(
        harness
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str(),
        STANDARD.encode([91; 32])
    );
    harness.vault.lock().unwrap();
    let error = harness
        .probe(OperationKind::ReadData, FixedKeyAction::Load)
        .unwrap_err();
    assert_eq!(error.rpc_code(), -32009);
    assert!(error.to_string().contains("VAULT_LOCKED"));
}

#[test]
#[ignore = "real Vault/SDK/stdio gate: execute only on GitHub runners"]
fn real_vault_missing_key_stays_missing_until_core_admits_initialization() {
    let mut harness = Harness::new();
    assert_eq!(
        harness
            .probe(OperationKind::ReadData, FixedKeyAction::Load)
            .unwrap()["present"],
        false
    );
    assert!(harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().is_none());
    assert_eq!(
        harness
            .probe(OperationKind::ReadData, FixedKeyAction::CreateIfAbsent)
            .unwrap_err()
            .rpc_code(),
        -32004
    );
    assert!(harness.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().is_none());
    let created = harness
        .probe(
            OperationKind::InitializeEmptyStore,
            FixedKeyAction::CreateIfAbsent,
        )
        .unwrap();
    assert_eq!(created["present"], true);
    assert_eq!(
        harness
            .probe(OperationKind::ReadData, FixedKeyAction::Load)
            .unwrap()["digest"],
        created["digest"]
    );
}
