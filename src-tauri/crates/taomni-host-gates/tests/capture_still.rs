//! GitHub-only real process, production pump/dispatcher and authenticated
//! WebSocket. The source is controlled pixels, not a physical-screen/TCC test.
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
use taomni_host_gates::host::{HostProcess, HostServiceConfig};
use taomni_plugin_api::{RequestId, RpcError, services::*};
use taomni_plugin_services::*;
use taomni_plugin_stream::{TransferPool, TransferUsage};
use taomni_profile_locks::*;

fn payload() -> Vec<u8> {
    encode_luma_frames(&[
        LumaFrameRef {
            width: 2,
            height: 2,
            luma: &[1, 2, 3, 4],
        },
        LumaFrameRef {
            width: 1,
            height: 2,
            luma: &[254, 255],
        },
    ])
    .unwrap()
}

struct NoVault;
impl CoreServiceBackend for NoVault {
    fn fixed_key(
        &self,
        _: RequestId,
        _: FixedKeyRequest,
        _: ReverseRequestPermit,
    ) -> Result<SensitiveServiceFrame, RpcError> {
        panic!("capture must not require a Vault key backend")
    }
}

struct Source {
    runtime: tokio::runtime::Handle,
    pool: TransferPool,
    calls: AtomicUsize,
    wait: bool,
}
impl StillCaptureService for Source {
    fn capture(&self, permit: ReverseRequestPermit) -> Result<SensitiveServiceFrame, RpcError> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        while self.wait {
            permit
                .check_current()
                .map_err(CoreServiceError::into_rpc_error)?;
            std::thread::sleep(Duration::from_millis(5));
        }
        permit
            .check_current()
            .map_err(CoreServiceError::into_rpc_error)?;
        let bytes = payload();
        let reservation = self.pool.reserve(bytes.capacity())?;
        let id = permit.request_id().clone();
        let operation = permit.retain_operation();
        let offer = self.runtime.block_on(offer_binary_for_request(
            permit,
            reservation,
            bytes,
            LUMA_FRAMES_CONTENT_TYPE,
            Default::default(),
        ))?;
        let result = CaptureStillResult {
            context: operation.context().clone(),
            binary: offer.descriptor().clone(),
        };
        SensitiveServiceFrame::binary(id, result, operation, offer)
            .map_err(CoreServiceError::into_rpc_error)
    }
}

struct Harness {
    process: HostProcess,
    dispatcher: Arc<CoreServiceDispatcher>,
    source: Arc<Source>,
    admission: OperationAdmission,
    root: ProfileRoot,
    sequence: u64,
    _runtime: tokio::runtime::Runtime,
    _directory: tempfile::TempDir,
}
impl Harness {
    fn new(wait: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(directory.path()).unwrap();
        let admission = OperationAdmission::new(
            ProfileGeneration::parse("a1234567-1234-1234-1234-123456789abc").unwrap(),
            VaultEpoch::new(1).unwrap(),
            false,
        );
        let dispatcher = Arc::new(
            CoreServiceDispatcher::new(admission.clone(), Arc::new(NoVault), Default::default())
                .unwrap(),
        );
        let grants = VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("capture-gate").unwrap(),
            BTreeSet::from([CAPTURE_SCREEN_PERMISSION.into()]),
            BTreeSet::new(),
        )
        .unwrap();
        let host = std::path::Path::new(env!("CARGO_BIN_EXE_host-gate-capture"));
        let process = HostProcess::start_with_services(
            "taomni-plugin-capture-gate",
            "0.1.0",
            host,
            host.parent().unwrap(),
            &["capture/probe".into()],
            &[CAPTURE_SCREEN_PERMISSION.into()],
            support::config(),
            Some(HostServiceConfig {
                dispatcher: dispatcher.clone(),
                grants,
            }),
        )
        .unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let source = Arc::new(Source {
            runtime: runtime.handle().clone(),
            pool: TransferPool::new(Default::default()).unwrap(),
            calls: AtomicUsize::new(0),
            wait,
        });
        Self {
            process,
            dispatcher,
            source,
            admission,
            root,
            sequence: 0,
            _runtime: runtime,
            _directory: directory,
        }
    }
    fn permit(&mut self, timeout: Duration) -> OperationPermit {
        self.sequence += 1;
        self.admission
            .admit_until(
                self.process.authorized_host().unwrap(),
                OperationId::parse(format!("b1234567-1234-1234-1234-{:012x}", self.sequence))
                    .unwrap(),
                OperationKind::ReadData,
                VaultOperationLease::try_read(&self.root).unwrap(),
                Instant::now() + timeout,
            )
            .unwrap()
    }
    fn assert_drained(&self) {
        support::wait_for(
            || {
                self.admission.in_flight_count() == 0
                    && self.source.pool.usage() == TransferUsage::default()
            },
            "capture and writer drain",
        );
        assert!(VaultOperationLease::try_write(&self.root).is_ok());
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.process
            .stop_confirmed(Instant::now() + Duration::from_secs(5))
            .unwrap();
        self.dispatcher.shutdown();
    }
}

#[test]
#[ignore = "real child process and loopback; run on GitHub"]
fn descriptor_flush_keeps_multidisplay_transfer_alive_and_the_sdk_receives_exact_pixels() {
    let mut harness = Harness::new(false);
    let expected = format!("{:x}", Sha256::digest(payload()));
    for _ in 0..2 {
        let mut permit = harness.permit(Duration::from_secs(5));
        permit.grant_still_capture(harness.source.clone()).unwrap();
        let instance = permit.context().host_instance.to_string();
        let result = harness
            .process
            .invoke_with_operation(permit, "capture/probe", None)
            .unwrap();
        assert_eq!(result["bytes"], payload().len());
        assert_eq!(result["sha256"], expected);
        assert_eq!(result["frames"], 2);
        assert_eq!(result["hostInstance"], instance);
        harness.assert_drained();
    }
    assert_eq!(harness.source.calls.load(Ordering::Acquire), 2);
}

#[test]
#[ignore = "real child process and loopback; run on GitHub"]
fn a_real_sdk_host_with_capture_permission_cannot_capture_without_a_core_window_grant() {
    let mut harness = Harness::new(false);
    let permit = harness.permit(Duration::from_secs(5));
    let error = harness
        .process
        .invoke_with_operation(permit, "capture/probe", None)
        .unwrap_err();
    assert_eq!(error.rpc_code(), -32004);
    assert_eq!(harness.source.calls.load(Ordering::Acquire), 0);
    harness.assert_drained();
}

#[test]
#[ignore = "real child process and loopback; run on GitHub"]
fn capture_deadline_discards_late_results_and_releases_the_actual_operation_lease() {
    let mut harness = Harness::new(true);
    let mut permit = harness.permit(Duration::from_millis(200));
    permit.grant_still_capture(harness.source.clone()).unwrap();
    let error = harness
        .process
        .invoke_with_operation(permit, "capture/probe", None)
        .unwrap_err();
    assert_eq!(error.rpc_code(), -32007);
    assert_eq!(harness.source.calls.load(Ordering::Acquire), 1);
    harness.assert_drained();
}

#[test]
#[ignore = "real child process and loopback; run on GitHub"]
fn session_drop_after_descriptor_flush_cancels_an_unclaimed_stream_and_releases_its_socket() {
    let mut harness = Harness::new(false);
    let mut permit = harness.permit(Duration::from_secs(5));
    permit.grant_still_capture(harness.source.clone()).unwrap();
    let host = harness.process.authorized_host().unwrap().clone();
    let mut session = ServiceSession::new(harness.dispatcher.clone(), host);
    let mut request = taomni_plugin_api::RpcRequest::new(
        format!("host/{}/session-drop", permit.context().host_instance),
        CAPTURE_STILL_METHOD,
        Some(serde_json::json!({})),
    );
    request.context = Some(permit.context().clone());
    session.submit(request).unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    let frame = loop {
        if let Some(reply) = session.try_completion().unwrap() {
            break reply.result.unwrap();
        }
        assert!(Instant::now() < until, "no capture descriptor");
        std::thread::sleep(Duration::from_millis(5));
    };
    let value: serde_json::Value = serde_json::from_slice(frame.current_bytes().unwrap()).unwrap();
    let result: CaptureStillResult = serde_json::from_value(value["result"].clone()).unwrap();
    let address: std::net::SocketAddrV4 = result
        .binary
        .stream_url
        .strip_prefix("ws://")
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    drop(frame); // the writer has flushed the descriptor; the listener remains owned
    assert!(std::net::TcpListener::bind(address).is_err());
    assert_eq!(harness.source.pool.usage().transfers, 1);
    drop(session);
    assert!(permit.check_current().is_err());
    support::wait_for(
        || std::net::TcpListener::bind(address).is_ok(),
        "unclaimed capture socket cleanup",
    );
    drop(permit);
    harness.assert_drained();
}
