//! Policy/dispatch units contain no capture, sockets or child processes.
use super::*;
use crate::StillCaptureService;
use taomni_plugin_api::{ErrorCode, RpcError};

#[derive(Default)]
struct Source(AtomicUsize);
impl StillCaptureService for Source {
    fn capture(&self, permit: ReverseRequestPermit) -> Result<SensitiveServiceFrame, RpcError> {
        permit
            .check_current()
            .map_err(CoreServiceError::into_rpc_error)?;
        self.0.fetch_add(1, Ordering::AcqRel);
        Err(RpcError::new(
            ErrorCode::InternalError,
            "CONTROLLED_CAPTURE_FAILURE",
        ))
    }
}

fn harness() -> Harness {
    let mut harness = Harness::new(false);
    harness.host = VerifiedHostGrants::from_verified_manifest(
        PluginSlug::parse("mfa").unwrap(),
        BTreeSet::from([CAPTURE_SCREEN_PERMISSION.into()]),
        BTreeSet::new(),
    )
    .unwrap()
    .bind_authenticated_transport(HostInstanceId::parse(HOST).unwrap());
    harness
}

fn capture_request(operation: &OperationPermit, id: u64) -> RpcRequest {
    let mut call = request(operation, id);
    call.method = CAPTURE_STILL_METHOD.into();
    call.params = Some(serde_json::json!({}));
    call
}

#[test]
fn permission_is_explicit_and_independent_of_fixed_keys() {
    let capture = VerifiedHostGrants::from_verified_manifest(
        PluginSlug::parse("mfa").unwrap(),
        BTreeSet::from([CAPTURE_SCREEN_PERMISSION.into()]),
        BTreeSet::new(),
    )
    .unwrap();
    assert!(
        capture
            .service_capabilities()
            .supports(CAPTURE_STILL_SERVICE, 1)
    );
    assert!(
        !capture
            .service_capabilities()
            .supports(FIXED_KEY_SERVICE, 1)
    );
    let harness = Harness::new(false);
    let mut operation = harness.operation(OperationKind::ReadData);
    assert_eq!(
        operation.grant_still_capture(Arc::new(Source::default())),
        Err(CoreServiceError::PermissionDenied)
    );
    assert_eq!(
        harness
            .session()
            .submit(capture_request(&operation, 1))
            .unwrap_err()
            .code,
        -32004
    );
}

#[test]
fn signed_permission_without_a_core_operation_source_cannot_capture() {
    let harness = harness();
    let operation = harness.operation(OperationKind::ReadData);
    let mut session = harness.session();
    session.submit(capture_request(&operation, 1)).unwrap();
    assert_eq!(completion(&mut session).result.err().unwrap().code, -32004);
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 0);
}

#[test]
fn a_granted_source_runs_once_and_replay_or_window_injection_cannot_reach_it() {
    let harness = harness();
    let mut operation = harness.operation(OperationKind::ReadData);
    let source = Arc::new(Source::default());
    operation.grant_still_capture(source.clone()).unwrap();
    assert_eq!(
        operation.grant_still_capture(source.clone()),
        Err(CoreServiceError::PermissionDenied)
    );
    let mut session = harness.session();
    let mut injected = capture_request(&operation, 1);
    injected.params = Some(serde_json::json!({"window":"other-user-window"}));
    assert_eq!(session.submit(injected).unwrap_err().code, -32602);
    assert_eq!(source.0.load(Ordering::Acquire), 0);
    let call = capture_request(&operation, 2);
    session.submit(call.clone()).unwrap();
    assert_eq!(
        completion(&mut session).result.err().unwrap().message,
        "CONTROLLED_CAPTURE_FAILURE"
    );
    assert_eq!(session.submit(call).unwrap_err().code, -32005);
    assert_eq!(source.0.load(Ordering::Acquire), 1);
    operation.cancel();
    assert_eq!(
        session
            .submit(capture_request(&operation, 3))
            .unwrap_err()
            .message,
        "STALE_PLUGIN_CONTEXT"
    );
    assert_eq!(source.0.load(Ordering::Acquire), 1);
}
