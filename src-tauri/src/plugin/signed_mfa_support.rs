//! Real release-signed artifact, installed registry and persisted Vault owners.
use crate::plugin::{
    ModuleManifest, PluginError,
    test_services::VaultHarness,
    verify::{VerifiedPackage, sha256_hex},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use taomni_plugin_services::OperationKind;
use taomni_profile_locks::{LeaseError, LeaseKind, PluginDataLease, PluginSlug};

pub(super) const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

pub(super) fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(15)
}

pub(in crate::plugin) struct InstalledMfa {
    pub state: VaultHarness,
    pub package: VerifiedPackage,
}

impl InstalledMfa {
    pub fn new() -> Self {
        let package = Self::verified_package();
        let state = VaultHarness::new();
        state.initialize();
        let record = state.registry.install_verified(&package).unwrap();
        assert!(record.reason.is_none());
        assert_eq!(&record.manifest, package.manifest());
        assert!(
            !state
                .services
                .root
                .path()
                .join("plugins/mfa/data/mfa.db")
                .exists()
        );
        state.registry.set_enabled("mfa", true).unwrap();
        Self { state, package }
    }

    pub(in crate::plugin) fn verified_package() -> VerifiedPackage {
        let artifact = PathBuf::from(
            std::env::var_os("TAOMNI_SIGNED_MFA_PACKAGE_DIR")
                .expect("hosted signed MFA artifact is required"),
        )
        .canonicalize()
        .unwrap();
        let source = std::env::var("TAOMNI_SIGNED_MFA_SOURCE_SHA").unwrap();
        assert_eq!(source.len(), 40);
        let receipt: Value =
            serde_json::from_slice(&fs::read(artifact.join("provenance.json")).unwrap()).unwrap();
        let mut expected: ModuleManifest =
            serde_json::from_str(include_str!("../../plugins/mfa/module.json")).unwrap();
        for (field, value) in [
            ("schema", "taomni.plugin-package.v1"),
            ("id", "taomni-plugin-mfa"),
            ("slug", "mfa"),
            ("version", expected.version.as_str()),
            ("coreApiVersion", "1"),
            ("trust", "plugins.updater.pubkey"),
            ("sourceSha", source.as_str()),
            ("platform", crate::plugin::current_platform()),
        ] {
            assert_eq!(receipt[field], value, "artifact identity: {field}");
        }
        let local = |name: &str| {
            let name = receipt[name].as_str().unwrap();
            assert_eq!(std::path::Path::new(name).file_name().unwrap(), name);
            let path = artifact.join(name);
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
            path
        };
        let archive = local("archive");
        let bytes = fs::read(&archive).unwrap();
        assert_eq!(receipt["sha256"], sha256_hex(&bytes));
        assert_eq!(receipt["size"], bytes.len() as u64);
        let signature = fs::read_to_string(local("signature")).unwrap();
        // qa-release-trust-gates selects the production embedded key in every
        // verifier, including later scan/enable/installed-tree verification.
        let package =
            VerifiedPackage::from_offline(&archive, &signature, crate::plugin::current_platform())
                .unwrap();
        if cfg!(windows) {
            expected.entry.host.as_mut().unwrap().push_str(".exe");
        }
        assert_eq!(package.manifest(), &expected);
        package
    }

    pub fn call(
        &self,
        kind: OperationKind,
        method: &str,
        params: Value,
    ) -> Result<Value, PluginError> {
        self.state.registry.invoke_scoped(
            "mfa",
            method,
            params,
            &uuid::Uuid::new_v4().to_string(),
            kind,
            deadline(),
        )
    }

    pub fn initialize(&self) {
        assert!(
            self.call(OperationKind::ReadData, "mfa_list", json!({}))
                .unwrap_err()
                .to_string()
                .contains("MFA_INITIALIZATION_REQUIRED")
        );
        assert!(
            self.state
                .vault
                .get_fixed(taomni_plugin_api::services::MFA_DATA_KEY_ID)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            self.call(
                OperationKind::InitializeEmptyStore,
                "mfa_initialize_empty",
                json!({})
            )
            .unwrap(),
            Value::Null
        );
    }

    pub fn add(&self) -> String {
        self.call(OperationKind::WriteData, "mfa_add", json!({"inputs":[{"issuer":"Release MFA gate","accountName":"qa@example.com","kind":"hotp","secret":SECRET}],"skipDuplicates":false}))
            .unwrap()["added"][0]["id"].as_str().unwrap().to_owned()
    }

    pub fn code(&self) -> Value {
        self.call(OperationKind::ReadData, "mfa_codes", json!({}))
            .unwrap()[0]
            .clone()
    }

    pub fn active(&self) -> PathBuf {
        self.state.registry.active_directory("mfa").unwrap()
    }

    pub fn assert_host_owns_installed_data(&self) -> String {
        let hosts = self.state.registry.hosts.lock().unwrap();
        let host = hosts.get("mfa").expect("installed host must be running");
        assert_eq!(host.directory, self.active());
        assert!(matches!(
            PluginDataLease::try_acquire(
                &self.state.services.root,
                &PluginSlug::parse("mfa").unwrap()
            ),
            Err(LeaseError::Busy(LeaseKind::PluginData))
        ));
        host.identity
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .instance()
            .to_string()
    }

    pub fn assert_data_released(&self) {
        assert!(
            self.state
                .registry
                .hosts
                .lock()
                .unwrap()
                .get("mfa")
                .is_none()
        );
        assert!(
            PluginDataLease::try_acquire(
                &self.state.services.root,
                &PluginSlug::parse("mfa").unwrap()
            )
            .is_ok()
        );
    }
}

impl Drop for InstalledMfa {
    fn drop(&mut self) {
        // Also clean up on an assertion failure. Successful scenarios explicitly
        // assert shutdown so a teardown error cannot become a passing receipt.
        let _ = self.state.registry.shutdown();
    }
}
