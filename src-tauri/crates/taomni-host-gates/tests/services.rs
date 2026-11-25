//! Real pipes/processes, production core pump and official SDK. The controlled
//! backend tests protocol timing; the root Vault gate tests actual stored keys.
mod support;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use taomni_host_gates::host::{HostProcess, HostProfileConfig, HostServiceConfig, HostState};
use taomni_plugin_api::{RequestId, RpcError, services::*};
use taomni_plugin_services::*;
use taomni_profile_locks::*;

struct Backend {
    delay: Duration,
    calls: AtomicUsize,
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
        let until = Instant::now() + self.delay;
        while Instant::now() < until {
            permit
                .check_current()
                .map_err(CoreServiceError::into_rpc_error)?;
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = FixedKeyResult::Key {
            context: permit.operation().context().clone(),
            key: SecretKey32::new([37; 32]),
        };
        SensitiveServiceFrame::encode(id, result, permit).map_err(CoreServiceError::into_rpc_error)
    }
}

struct Harness {
    root: ProfileRoot,
    admission: OperationAdmission,
    backend: Arc<Backend>,
    process: HostProcess,
    operation: u64,
    _dir: tempfile::TempDir,
}

impl Harness {
    fn new(delay: Duration) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(dir.path()).unwrap();
        let generation = ProfileGeneration::parse("a1234567-1234-1234-1234-123456789abc").unwrap();
        std::fs::write(
            root.path().join(".profile-state.json"),
            serde_json::to_vec(&serde_json::json!({"formatVersion":1,"generation":generation}))
                .unwrap(),
        )
        .unwrap();
        let admission =
            OperationAdmission::new(generation.clone(), VaultEpoch::new(1).unwrap(), false);
        let backend = Arc::new(Backend {
            delay,
            calls: AtomicUsize::new(0),
        });
        let dispatcher = Arc::new(
            CoreServiceDispatcher::new(
                admission.clone(),
                backend.clone(),
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
        let host = std::path::Path::new(env!("CARGO_BIN_EXE_host-gate-services"));
        let process = HostProcess::start_profiled(
            HostProfileConfig::new(root.clone(), PluginSlug::parse("mfa").unwrap(), generation),
            "taomni-plugin-mfa",
            "0.1.0",
            host,
            host.parent().unwrap(),
            &[
                "service/probe".into(),
                "service/wait".into(),
                "service/crash".into(),
            ],
            &[FIXED_KEY_SERVICE.into()],
            support::config(),
            Some(HostServiceConfig { dispatcher, grants }),
        )
        .unwrap();
        assert!(ProfileRestoreLease::try_acquire(&root).is_err());
        assert!(PluginDataLease::try_acquire(&root, &PluginSlug::parse("mfa").unwrap()).is_err());
        Self {
            _dir: dir,
            root,
            admission,
            backend,
            process,
            operation: 0,
        }
    }

    fn permit(&mut self, timeout: Duration) -> OperationPermit {
        self.operation += 1;
        self.admission
            .admit_until(
                self.process.authorized_host().unwrap(),
                OperationId::parse(format!("b1234567-1234-1234-1234-{:012x}", self.operation))
                    .unwrap(),
                OperationKind::ReadData,
                VaultOperationLease::try_read(&self.root).unwrap(),
                Instant::now() + timeout,
            )
            .unwrap()
    }

    fn probe(&mut self) -> serde_json::Value {
        let permit = self.permit(Duration::from_secs(6));
        self.process
            .invoke_with_operation(permit, "service/probe", None)
            .unwrap()
    }
}

#[test]
#[ignore = "real stdio core/SDK gate: GitHub runners only"]
fn reverse_service_can_exceed_normal_invoke_timeout_while_heartbeats_continue() {
    let mut harness = Harness::new(Duration::from_millis(3300));
    let result = harness.probe();
    assert_eq!(result["present"], true);
    assert_eq!(result["digest"], format!("{:x}", Sha256::digest([37; 32])));
    assert_eq!(harness.process.state(), HostState::Running);
    assert!(VaultOperationLease::try_write(&harness.root).is_ok());
}

#[test]
#[ignore = "70,000 real core/SDK stdio calls: GitHub runners only"]
fn fresh_operations_and_sdk_commands_cross_the_old_transport_lifetime_limit() {
    let mut harness = Harness::new(Duration::ZERO);
    assert_eq!(harness.probe()["present"], true);
    let host = harness.process.authorized_host().unwrap().clone();
    let started = Instant::now();
    for sequence in 1..=70_000 {
        assert!(
            started.elapsed() < Duration::from_secs(600),
            "long-lived host gate exceeded its budget"
        );
        let permit = harness
            .admission
            .admit_new_until(
                &host,
                OperationKind::ReadData,
                VaultOperationLease::try_read(&harness.root).unwrap(),
                Instant::now() + Duration::from_secs(6),
            )
            .unwrap();
        let result = harness
            .process
            .invoke_with_operation(
                permit,
                "service/probe",
                Some(serde_json::json!({"echo": sequence})),
            )
            .unwrap();
        assert_eq!(result["echo"], sequence);
        assert_eq!(result["handled"], sequence);
        assert_eq!(result["hostInstance"], host.instance().as_str());
        if sequence % 10_000 == 0 {
            println!(
                "long-lived host: {sequence} actual stdio calls in {:?}",
                started.elapsed()
            );
        }
    }
    assert_eq!(harness.admission.in_flight_count(), 0);
    assert_eq!(
        harness.process.authorized_host().unwrap().instance(),
        host.instance()
    );
    assert_eq!(harness.process.state(), HostState::Running);
    // Echoes exercise actual command transport/admission, not key retrieval.
    // Real reverse RPC/key access must still work after crossing the old cap.
    assert_eq!(harness.probe()["present"], true);
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 2);
    assert!(VaultOperationLease::try_write(&harness.root).is_ok());
}

#[test]
#[ignore = "real stdio core/SDK gate: GitHub runners only"]
fn cancel_while_sdk_waits_for_key_does_not_publish_a_late_success() {
    let mut harness = Harness::new(Duration::from_secs(3));
    let permit = harness.permit(Duration::from_secs(6));
    let id: RequestId = format!(
        "core/{}/{}",
        permit.context().host_instance,
        permit.context().operation
    )
    .into();
    let handle = harness.process.cancellation_handle();
    handle.register(&id);
    let backend = harness.backend.clone();
    let canceller = std::thread::spawn(move || {
        support::wait_for(
            || backend.calls.load(Ordering::Acquire) > 0,
            "reverse service started",
        );
        assert!(handle.cancel(&id));
    });
    let started = Instant::now();
    assert_eq!(
        harness
            .process
            .invoke_with_operation(permit, "service/probe", None)
            .unwrap_err()
            .rpc_code(),
        -32006
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    canceller.join().unwrap();
    assert_eq!(harness.process.state(), HostState::Running);
    support::wait_for(
        || VaultOperationLease::try_write(&harness.root).is_ok(),
        "cancelled worker releases original lease",
    );
}

#[test]
#[ignore = "real stdio core/SDK gate: GitHub runners only"]
fn restart_gets_new_authenticated_identity_and_rejects_old_transport_operation() {
    let mut harness = Harness::new(Duration::ZERO);
    let old_host = harness.process.authorized_host().unwrap().clone();
    let permit = harness.permit(Duration::from_secs(6));
    assert!(
        harness
            .process
            .invoke_with_operation(permit, "service/crash", None)
            .is_err()
    );
    support::restart(&mut harness.process);
    assert_ne!(
        harness.process.authorized_host().unwrap().instance(),
        old_host.instance()
    );
    assert!(old_host.termination_confirmed());
    assert!(matches!(
        harness.admission.admit_until(
            &old_host,
            OperationId::parse("c1234567-1234-1234-1234-123456789abc").unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&harness.root).unwrap(),
            Instant::now() + Duration::from_secs(3),
        ),
        Err(CoreServiceError::StalePluginContext)
    ));
    assert_eq!(harness.probe()["present"], true);
}

#[test]
#[ignore = "real stdio core/SDK gate: GitHub runners only"]
fn expired_operation_terminates_transport_before_a_late_key_can_be_published() {
    let mut harness = Harness::new(Duration::from_secs(3));
    let host = harness.process.authorized_host().unwrap().clone();
    let permit = harness.permit(Duration::from_millis(150));
    assert_eq!(
        harness
            .process
            .invoke_with_operation(permit, "service/probe", None)
            .unwrap_err()
            .rpc_code(),
        -32007
    );
    assert_ne!(harness.process.state(), HostState::Running);
    assert!(harness.process.authorized_host().is_none());
    harness
        .process
        .stop_confirmed(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(host.termination_confirmed());
    assert!(
        PluginDataLease::try_acquire(&harness.root, &PluginSlug::parse("mfa").unwrap()).is_ok()
    );
    support::wait_for(
        || VaultOperationLease::try_write(&harness.root).is_ok(),
        "timed out reverse worker releases lease",
    );
}

#[test]
#[ignore = "real stdio core/SDK gate: GitHub runners only"]
fn revoke_acknowledgement_blocks_old_epochs_and_a_new_epoch_can_work() {
    let mut harness = Harness::new(Duration::ZERO);
    harness.probe();
    let host = harness.process.authorized_host().unwrap().clone();
    let revoke = harness
        .admission
        .begin_revoke(std::slice::from_ref(&host))
        .unwrap();
    let reply = harness
        .process
        .revoke_keys(&revoke, Instant::now() + Duration::from_secs(2))
        .unwrap();
    harness.admission.acknowledge_revoke(&host, &reply).unwrap();
    harness
        .admission
        .wait_revoke_drained(Instant::now() + Duration::from_secs(2), &|| false)
        .unwrap();
    harness.admission.finish_revoke(&revoke).unwrap();
    harness.admission.after_verified_unlock().unwrap();
    assert_eq!(harness.probe()["present"], true);
}

#[test]
#[ignore = "real stdio core/SDK termination gate: GitHub runners only"]
fn confirmed_stop_drains_a_live_service_host_before_admission_can_lock() {
    let mut harness = Harness::new(Duration::ZERO);
    harness.probe();
    let host = harness.process.authorized_host().unwrap().clone();
    let revoke = harness
        .admission
        .begin_revoke(std::slice::from_ref(&host))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    harness.process.stop_confirmed(deadline).unwrap();
    assert!(host.termination_confirmed());
    // The transport already delivered the kernel receipt; a coordinator retry
    // for the same revocation remains valid.
    harness
        .admission
        .confirm_host_terminated(&host, &revoke)
        .unwrap();
    harness
        .admission
        .wait_revoke_drained(deadline, &|| false)
        .unwrap();
    harness.admission.finish_revoke(&revoke).unwrap();
    assert_eq!(harness.process.state(), HostState::Stopped);
}

#[test]
#[ignore = "real stdio core/SDK crash termination gate: GitHub runners only"]
fn confirmed_stop_keeps_crashed_transport_ownership_until_termination_is_observed() {
    let mut harness = Harness::new(Duration::ZERO);
    let host = harness.process.authorized_host().unwrap().clone();
    let historical = harness.permit(Duration::from_secs(5));
    let borrowed = harness
        .admission
        .borrow_operation(&host, historical.context())
        .unwrap();
    let permit = harness.permit(Duration::from_secs(5));
    assert!(
        harness
            .process
            .invoke_with_operation(permit, "service/crash", None)
            .is_err()
    );
    assert!(harness.process.authorized_host().is_none());
    assert!(!host.termination_confirmed());
    harness
        .process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
    assert!(host.termination_confirmed());
    let revoke = harness
        .admission
        .begin_revoke(std::slice::from_ref(&host))
        .unwrap();
    assert!(
        revoke.hosts.is_empty(),
        "retired transport must not leave an impossible revoke ack"
    );
    assert_eq!(
        borrowed.check_current(),
        Err(CoreServiceError::StalePluginContext)
    );
    assert_eq!(
        harness.admission.finish_revoke(&revoke),
        Err(CoreServiceError::CoreServiceBusy)
    );
    drop(historical);
    assert_eq!(
        harness.admission.finish_revoke(&revoke),
        Err(CoreServiceError::CoreServiceBusy)
    );
    drop(borrowed);
    harness
        .admission
        .wait_revoke_drained(Instant::now() + Duration::from_secs(5), &|| false)
        .unwrap();
    harness.admission.finish_revoke(&revoke).unwrap();
    assert_eq!(harness.process.state(), HostState::Stopped);
    assert!(VaultOperationLease::try_write(&harness.root).is_ok());
}

#[test]
#[ignore = "real stdio core/SDK gate: GitHub runners only"]
fn generic_renderer_invoke_cannot_supply_operation_context_or_reach_key_service() {
    let mut harness = Harness::new(Duration::ZERO);
    assert_eq!(
        harness
            .process
            .invoke_with_id(
                "renderer-id".into(),
                "service/probe",
                Some(serde_json::json!({"context":{}}))
            )
            .unwrap_err()
            .rpc_code(),
        -32009
    );
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 0);
}
