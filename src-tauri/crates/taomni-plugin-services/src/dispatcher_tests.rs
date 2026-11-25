//! In-memory worker/queue tests; no subprocesses or network fixtures.
#[path = "capture_tests.rs"]
mod capture_tests;
use crate::*;
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use taomni_plugin_api::{RequestId, RpcRequest, services::*};
use taomni_profile_locks::*;

const HOST: &str = "a1234567-1234-1234-1234-123456789abc";
const OPERATION: &str = "b1234567-1234-1234-1234-123456789abc";

#[derive(Default)]
struct Backend {
    calls: AtomicUsize,
    blocked: Mutex<bool>,
    changed: Condvar,
}

impl Backend {
    fn release(&self) {
        *self.blocked.lock().unwrap() = false;
        self.changed.notify_all();
    }

    fn wait_for_call(&self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.calls.load(Ordering::Acquire) == 0 {
            assert!(Instant::now() < deadline, "worker did not start");
            std::thread::yield_now();
        }
    }
}

impl CoreServiceBackend for Backend {
    fn fixed_key(
        &self,
        id: RequestId,
        request: FixedKeyRequest,
        permit: ReverseRequestPermit,
    ) -> Result<SensitiveServiceFrame, taomni_plugin_api::RpcError> {
        permit
            .authorize_fixed_key(&request)
            .map_err(CoreServiceError::into_rpc_error)?;
        self.calls.fetch_add(1, Ordering::Release);
        let blocked = self.blocked.lock().unwrap();
        let (blocked, timeout) = self
            .changed
            .wait_timeout_while(blocked, Duration::from_secs(3), |value| *value)
            .unwrap();
        assert!(
            !timeout.timed_out() || !*blocked,
            "test must release worker"
        );
        let result = FixedKeyResult::Key {
            context: permit.operation().context().clone(),
            key: SecretKey32::new([19; 32]),
        };
        SensitiveServiceFrame::encode(id, result, permit).map_err(CoreServiceError::into_rpc_error)
    }
}

struct Harness {
    root: ProfileRoot,
    admission: OperationAdmission,
    host: AuthorizedHost,
    backend: Arc<Backend>,
    dispatcher: Arc<CoreServiceDispatcher>,
    _dir: tempfile::TempDir,
}

impl Harness {
    fn new(blocked: bool) -> Self {
        Self::with_config(
            blocked,
            DispatcherConfig {
                workers: 1,
                queued: 1,
            },
        )
    }

    fn with_config(blocked: bool, config: DispatcherConfig) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(dir.path()).unwrap();
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
        let backend = Arc::new(Backend::default());
        *backend.blocked.lock().unwrap() = blocked;
        let dispatcher = Arc::new(
            CoreServiceDispatcher::new(admission.clone(), backend.clone(), config).unwrap(),
        );
        Self {
            _dir: dir,
            root,
            admission,
            host,
            backend,
            dispatcher,
        }
    }

    fn operation(&self, kind: OperationKind) -> OperationPermit {
        self.admission
            .admit_until(
                &self.host,
                OperationId::parse(OPERATION).unwrap(),
                kind,
                VaultOperationLease::try_read(&self.root).unwrap(),
                Instant::now() + Duration::from_secs(10),
            )
            .unwrap()
    }

    fn session(&self) -> ServiceSession {
        ServiceSession::new(self.dispatcher.clone(), self.host.clone())
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.backend.release();
    }
}

fn request(operation: &OperationPermit, number: u64) -> RpcRequest {
    let mut request = RpcRequest::new(
        format!("host/{HOST}/{number}"),
        FIXED_KEY_METHOD,
        Some(
            serde_json::to_value(FixedKeyRequest {
                key_id: FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap(),
                action: FixedKeyAction::Load,
            })
            .unwrap(),
        ),
    );
    request.context = Some(operation.context().clone());
    request
}

fn completion(session: &mut ServiceSession) -> ServiceCompletion {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(reply) = session.try_completion().unwrap() {
            return reply;
        }
        assert!(Instant::now() < deadline, "no completion");
        std::thread::yield_now();
    }
}

#[test]
fn scoped_reply_is_typed_and_replay_cannot_execute_a_second_time() {
    let harness = Harness::new(false);
    let operation = harness.operation(OperationKind::ReadData);
    let mut session = harness.session();
    let request = request(&operation, 1);
    session.submit(request.clone()).unwrap();
    let reply = completion(&mut session).result.unwrap();
    #[derive(serde::Deserialize)]
    struct Reply {
        result: FixedKeyResult,
    }
    let decoded: Reply = serde_json::from_slice(reply.current_bytes().unwrap()).unwrap();
    let FixedKeyResult::Key { context, key } = decoded.result else {
        panic!("key missing")
    };
    assert_eq!(context, *operation.context());
    assert_eq!(key.as_bytes(), &[19; 32]);
    drop(reply);
    assert_eq!(session.submit(request).unwrap_err().code, -32005);
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 1);
}

#[test]
fn direction_missing_context_and_foreign_context_are_rejected_before_backend() {
    let harness = Harness::new(false);
    let operation = harness.operation(OperationKind::ReadData);
    let mut session = harness.session();
    let mut wrong = request(&operation, 1);
    wrong.id = RequestId::Number(1);
    assert_eq!(session.submit(wrong).unwrap_err().code, -32600);
    let mut wrong = request(&operation, 2);
    wrong.id = format!("core/{HOST}/3").into();
    assert_eq!(session.submit(wrong).unwrap_err().code, -32600);
    let mut wrong = request(&operation, 3);
    wrong.context = None;
    assert_eq!(
        session.submit(wrong).unwrap_err().message,
        "STALE_PLUGIN_CONTEXT"
    );
    let mut wrong = request(&operation, 4);
    wrong.context.as_mut().unwrap().host_instance = HostInstanceId::parse(OPERATION).unwrap();
    assert_eq!(
        session.submit(wrong).unwrap_err().message,
        "STALE_PLUGIN_CONTEXT"
    );
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 0);
}

#[test]
fn full_global_queue_returns_busy_and_does_not_replay_the_rejected_id() {
    let harness = Harness::new(true);
    let operation = harness.operation(OperationKind::ReadData);
    let mut session = harness.session();
    session.submit(request(&operation, 1)).unwrap();
    harness.backend.wait_for_call();
    session.submit(request(&operation, 2)).unwrap();
    let rejected = request(&operation, 3);
    assert_eq!(
        session.submit(rejected.clone()).unwrap_err().message,
        "CORE_SERVICE_BUSY"
    );
    assert_eq!(session.submit(rejected).unwrap_err().code, -32005);
    harness.backend.release();
    drop(completion(&mut session));
    drop(completion(&mut session));
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 2);
}

#[test]
fn per_session_limit_is_bounded_and_overflow_id_cannot_be_replayed() {
    let harness = Harness::with_config(
        true,
        DispatcherConfig {
            workers: 1,
            queued: 16,
        },
    );
    let operation = harness.operation(OperationKind::ReadData);
    let mut session = harness.session();
    for id in 1..=8 {
        session.submit(request(&operation, id)).unwrap();
    }
    let rejected = request(&operation, 9);
    assert_eq!(
        session.submit(rejected.clone()).unwrap_err().message,
        "CORE_SERVICE_BUSY"
    );
    assert_eq!(session.submit(rejected).unwrap_err().code, -32005);
    harness.backend.release();
    for _ in 0..8 {
        drop(completion(&mut session));
    }
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 8);
}

#[test]
fn cancellation_drops_late_secret_and_keeps_lease_until_worker_finishes() {
    let harness = Harness::new(true);
    let operation = harness.operation(OperationKind::ReadData);
    let mut session = harness.session();
    session.submit(request(&operation, 1)).unwrap();
    harness.backend.wait_for_call();
    operation.cancel();
    drop(operation);
    assert!(VaultOperationLease::try_write(&harness.root).is_err());
    harness.backend.release();
    let reply = completion(&mut session);
    assert_eq!(reply.result.err().unwrap().message, "STALE_PLUGIN_CONTEXT");
    assert!(VaultOperationLease::try_write(&harness.root).is_ok());
}

#[test]
fn replaced_session_invalidates_operation_and_never_routes_its_old_completion() {
    let harness = Harness::new(true);
    let operation = harness.operation(OperationKind::ReadData);
    let mut old = harness.session();
    old.submit(request(&operation, 1)).unwrap();
    harness.backend.wait_for_call();
    drop(old);
    assert_eq!(
        operation.check_current(),
        Err(CoreServiceError::StalePluginContext)
    );
    let mut new = harness.session();
    assert_eq!(
        new.submit(request(&operation, 2)).unwrap_err().message,
        "STALE_PLUGIN_CONTEXT"
    );
    harness.backend.release();
    assert!(new.try_completion().unwrap().is_none());
}

#[test]
fn export_grant_validation_consumes_once_and_never_invokes_key_backend() {
    let harness = Harness::new(false);
    let operation = harness.operation(OperationKind::ExportSecret);
    let grant = ExportGrantId::parse(HOST).unwrap();
    operation
        .grant_export_after_verified_password(grant.clone())
        .unwrap();
    let mut session = harness.session();
    let mut call = request(&operation, 1);
    call.method = EXPORT_GRANT_METHOD.into();
    call.params = Some(serde_json::to_value(ExportGrantRequest { grant }).unwrap());
    session.submit(call.clone()).unwrap();
    let reply = completion(&mut session).result.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(reply.current_bytes().unwrap()).unwrap()["result"],
        true
    );
    call.id = format!("host/{HOST}/2").into();
    session.submit(call).unwrap();
    assert_eq!(completion(&mut session).result.err().unwrap().code, -32004);
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 0);
}

#[test]
fn expired_core_deadline_and_unauthorized_keys_never_reach_backend() {
    let harness = Harness::new(false);
    assert!(matches!(
        harness.admission.admit_until(
            &harness.host,
            OperationId::parse(OPERATION).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&harness.root).unwrap(),
            Instant::now()
        ),
        Err(CoreServiceError::TimedOut)
    ));
    let operation = harness.operation(OperationKind::ReadData);
    let mut session = harness.session();
    let mut call = request(&operation, 1);
    call.params.as_mut().unwrap()["keyId"] = "other.secret".into();
    assert_eq!(session.submit(call).unwrap_err().code, -32004);
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 0);
}

#[test]
fn monotonic_service_rejections_cross_the_old_cap_and_still_cannot_replay() {
    let harness = Harness::new(false);
    let operation = harness.operation(OperationKind::ReadData);
    let mut session = ServiceSession::with_request_id_mode(
        harness.dispatcher.clone(),
        harness.host.clone(),
        taomni_plugin_api::RequestIdMode::MonotonicV1,
    );
    for sequence in 1..=70_000 {
        let mut call = request(&operation, sequence);
        call.params = None;
        assert_eq!(session.submit(call).unwrap_err().code, -32602);
    }
    assert_eq!(
        session.submit(request(&operation, 1)).unwrap_err().code,
        -32005
    );
    assert_eq!(
        session
            .submit(request(&operation, 70_000))
            .unwrap_err()
            .code,
        -32005
    );
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 0);
    session.submit(request(&operation, 70_001)).unwrap();
    assert!(completion(&mut session).result.is_ok());
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 1);
}
