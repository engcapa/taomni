//! Controlled keys exercise the actual MFA executable and production core
//! dispatcher. Root Vault gates separately prove persisted Vault storage.
#![allow(dead_code)]
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use taomni_host_gates::host::{
    HostProcess, HostProcessError, HostProfileConfig, HostServiceConfig, HostSupervisorConfig,
};
use taomni_plugin_api::{RequestId, RpcError, services::*};
use taomni_plugin_services::*;
use taomni_profile_locks::*;

pub const ID: &str = "a1234567-1234-1234-1234-123456789abc";
pub const OTHER: &str = "b1234567-1234-1234-1234-123456789abc";
pub const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
pub const KEY: [u8; 32] = [37; 32];

pub struct Backend {
    pub key: Mutex<Result<Option<[u8; 32]>, CoreServiceError>>,
    pub calls: AtomicUsize,
    pub creations: AtomicUsize,
    pub repairs: AtomicUsize,
    pub delay_ms: AtomicUsize,
}
impl CoreServiceBackend for Backend {
    fn fixed_key(
        &self,
        id: RequestId,
        request: FixedKeyRequest,
        permit: ReverseRequestPermit,
    ) -> Result<SensitiveServiceFrame, RpcError> {
        permit
            .authorize_fixed_key(&request)
            .map_err(CoreServiceError::into_rpc_error)?;
        self.calls.fetch_add(1, Ordering::AcqRel);
        let end =
            Instant::now() + Duration::from_millis(self.delay_ms.load(Ordering::Acquire) as u64);
        while Instant::now() < end {
            permit
                .check_current()
                .map_err(CoreServiceError::into_rpc_error)?;
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut key = self.key.lock().unwrap();
        match request.action {
            FixedKeyAction::Load => (),
            FixedKeyAction::CreateIfAbsent => {
                if matches!(*key, Ok(None)) {
                    *key = Ok(Some(KEY));
                    self.creations.fetch_add(1, Ordering::AcqRel);
                }
            }
            FixedKeyAction::RepairEmptyAfterReset { .. } => {
                if !matches!(*key, Ok(Some(_))) {
                    *key = Ok(Some(KEY));
                }
                self.repairs.fetch_add(1, Ordering::AcqRel);
            }
        }
        let result = match *key {
            Ok(Some(key)) => FixedKeyResult::Key {
                context: permit.operation().context().clone(),
                key: SecretKey32::new(key),
            },
            Ok(None) => FixedKeyResult::Missing,
            Err(error) => return Err(error.into_rpc_error()),
        };
        SensitiveServiceFrame::encode(id, result, permit).map_err(CoreServiceError::into_rpc_error)
    }
}

pub struct Harness {
    pub process: HostProcess,
    pub backend: Arc<Backend>,
    pub root: ProfileRoot,
    pub admission: OperationAdmission,
    pub sequence: u64,
    _dir: tempfile::TempDir,
}
impl Harness {
    pub fn new() -> Self {
        let path = PathBuf::from(
            std::env::var_os("TAOMNI_MFA_PLUGIN_BIN")
                .expect("GitHub gate requires the actual MFA executable"),
        );
        Self::with_executable(&path)
    }

    pub fn with_executable(path: &std::path::Path) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(dir.path()).unwrap();
        std::fs::write(
            root.path().join(".profile-state.json"),
            serde_json::to_vec(&serde_json::json!({"formatVersion":1,"generation":ID})).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(Backend {
            key: Mutex::new(Ok(None)),
            calls: AtomicUsize::new(0),
            creations: AtomicUsize::new(0),
            repairs: AtomicUsize::new(0),
            delay_ms: AtomicUsize::new(0),
        });
        let admission = OperationAdmission::new(
            ProfileGeneration::parse(ID).unwrap(),
            VaultEpoch::new(1).unwrap(),
            false,
        );
        let process = Self::start_at(&root, admission.clone(), backend.clone(), path);
        Self {
            process,
            backend,
            root,
            admission,
            sequence: 0,
            _dir: dir,
        }
    }

    pub fn start(
        root: &ProfileRoot,
        admission: OperationAdmission,
        backend: Arc<Backend>,
    ) -> HostProcess {
        let path = PathBuf::from(
            std::env::var_os("TAOMNI_MFA_PLUGIN_BIN")
                .expect("GitHub gate requires the actual MFA executable"),
        );
        Self::start_at(root, admission, backend, &path)
    }

    fn start_at(
        root: &ProfileRoot,
        admission: OperationAdmission,
        backend: Arc<Backend>,
        path: &std::path::Path,
    ) -> HostProcess {
        assert!(path.is_absolute() && path.is_file());
        let dispatcher = Arc::new(
            CoreServiceDispatcher::new(admission, backend, DispatcherConfig::default()).unwrap(),
        );
        let config = taomni_plugin_mfa::host_config();
        let grants = VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("mfa").unwrap(),
            config.permissions.clone(),
            BTreeSet::from([MFA_DATA_KEY_ID.into()]),
        )
        .unwrap();
        HostProcess::start_profiled(
            HostProfileConfig::new(
                root.clone(),
                PluginSlug::parse("mfa").unwrap(),
                ProfileGeneration::parse(ID).unwrap(),
            ),
            &config.plugin_id,
            &config.plugin_version,
            path,
            path.parent().unwrap(),
            &config.commands.into_iter().collect::<Vec<_>>(),
            &config.permissions.into_iter().collect::<Vec<_>>(),
            HostSupervisorConfig {
                request_timeout: Duration::from_secs(5),
                heartbeat_timeout: Duration::from_secs(2),
                ..Default::default()
            },
            Some(HostServiceConfig { dispatcher, grants }),
        )
        .unwrap()
    }

    pub fn permit(&mut self, kind: OperationKind) -> OperationPermit {
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
                OperationId::parse(format!("c1234567-1234-1234-1234-{:012x}", self.sequence))
                    .unwrap(),
                kind,
                lease,
                deadline(),
            )
            .unwrap()
    }
    pub fn call(
        &mut self,
        kind: OperationKind,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, HostProcessError> {
        let permit = self.permit(kind);
        self.process.invoke_with_operation(permit, method, params)
    }
    pub fn initialize(&mut self) {
        assert!(
            self.call(OperationKind::ReadData, "mfa_list", None)
                .unwrap_err()
                .to_string()
                .contains("MFA_INITIALIZATION_REQUIRED")
        );
        assert_eq!(self.backend.creations.load(Ordering::Acquire), 0);
        self.call(
            OperationKind::InitializeEmptyStore,
            "mfa_initialize_empty",
            None,
        )
        .unwrap();
        assert_eq!(self.backend.creations.load(Ordering::Acquire), 1);
    }
    pub fn add(&mut self) -> String {
        let value = self
            .call(OperationKind::WriteData, "mfa_add", Some(input()))
            .unwrap();
        value["added"][0]["id"].as_str().unwrap().into()
    }
    pub fn list(&mut self) -> serde_json::Value {
        self.call(OperationKind::ReadData, "mfa_list", None)
            .unwrap()
    }
    pub fn codes(&mut self) -> serde_json::Value {
        self.call(OperationKind::ReadData, "mfa_codes", None)
            .unwrap()
    }
    pub fn restart(&mut self) {
        self.process.stop_confirmed(deadline()).unwrap();
        assert!(
            PluginDataLease::try_acquire(&self.root, &PluginSlug::parse("mfa").unwrap()).is_ok()
        );
        self.process = Self::start(&self.root, self.admission.clone(), self.backend.clone());
    }
    pub fn source(&self) -> PathBuf {
        self.root.path().join("plugins/mfa/data/mfa.db")
    }
    pub fn snapshot_request(&self, job: &str, files: &[&str]) -> PrepareSnapshot {
        let path = self.root.path().join(job);
        std::fs::create_dir(&path).unwrap();
        PrepareSnapshot {
            job: SnapshotJobId::parse(job).unwrap(),
            profile_generation: ProfileGeneration::parse(ID).unwrap(),
            destination: SnapshotDestinationGrant {
                token: StagingToken::parse(job).unwrap(),
                absolute_job_root: path,
                allowed_files: files
                    .iter()
                    .map(|path| SafeRelativePath::parse(*path).unwrap())
                    .collect(),
                opaque_files: Vec::new(),
            },
        }
    }
}

pub fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
pub fn input() -> serde_json::Value {
    serde_json::json!({"inputs":[{"issuer":"RFC","accountName":"qa@example.com","kind":"hotp","secret":SECRET}],"skipDuplicates":false})
}
