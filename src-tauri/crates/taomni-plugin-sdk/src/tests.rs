//! Pure units by default; ignored socket and real stdio tests run on GitHub.
#[path = "capture_native_tests.rs"]
mod capture_native_tests;
#[path = "capture_tests.rs"]
mod capture_tests;
use crate::{
    client::ServiceClient,
    operation::Operation,
    runtime::{HostConfig, handshake},
    sensitive::{LineReader, MAX_FRAME},
};
use std::{
    collections::BTreeSet,
    io::{self, Read},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};
use taomni_plugin_api::{HandshakeRequest, RequestId, RpcMessage, RpcRequest, services::*};

const HOST: &str = "a1234567-1234-1234-1234-123456789abc";

fn context() -> OperationContext {
    OperationContext {
        host_instance: HostInstanceId::parse(HOST).unwrap(),
        operation: OperationId::parse(HOST).unwrap(),
        profile_generation: ProfileGeneration::parse(HOST).unwrap(),
        vault_epoch: VaultEpoch::new(1).unwrap(),
    }
}

fn key_request() -> FixedKeyRequest {
    FixedKeyRequest {
        key_id: FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap(),
        action: FixedKeyAction::Load,
    }
}

fn operation() -> (
    Arc<Operation>,
    Arc<ServiceClient>,
    mpsc::Receiver<RpcMessage>,
) {
    let (sender, receiver) = mpsc::sync_channel(8);
    let client = ServiceClient::new(sender);
    let operation = Arc::new(Operation::new(
        Some(context()),
        Instant::now() + Duration::from_secs(5),
        client.clone(),
    ));
    (operation, client, receiver)
}

fn take_request(receiver: &mpsc::Receiver<RpcMessage>) -> RpcRequest {
    let RpcMessage::Request(request) = receiver.recv_timeout(Duration::from_secs(2)).unwrap()
    else {
        panic!("not a request")
    };
    request
}

fn deliver(client: &ServiceClient, id: RequestId, context: OperationContext) {
    let mut bytes = SensitiveRpcResponse::success(
        id,
        FixedKeyResult::Key {
            context,
            key: SecretKey32::new([29; 32]),
        },
    )
    .encode_line()
    .unwrap();
    client.deliver(&mut bytes).unwrap();
    assert!(bytes.is_empty());
}

#[test]
fn fixed_key_reply_is_typed_and_guard_is_cleared_before_reuse() {
    let (operation, client, receiver) = operation();
    let task = std::thread::spawn(move || {
        let key = operation.fixed_key(key_request()).unwrap().unwrap();
        assert_eq!(key.with_key(|bytes| bytes[0]).unwrap(), 29);
        assert_eq!(format!("{key:?}"), "OperationKey([REDACTED])");
        operation.clear_keys();
        assert!(key.with_key(|_| ()).is_err());
    });
    let request = take_request(&receiver);
    assert_eq!(request.context, Some(context()));
    assert!(request.id.to_string().starts_with(&format!("host/{HOST}/")));
    deliver(&client, request.id, context());
    task.join().unwrap();
}

#[test]
fn cancellation_unblocks_a_waiter_and_only_its_one_late_reply_is_discarded() {
    let (operation, client, receiver) = operation();
    let waiter = operation.clone();
    let task = std::thread::spawn(move || waiter.fixed_key(key_request()).err().unwrap().code);
    let request = take_request(&receiver);
    operation.cancel();
    assert_eq!(task.join().unwrap(), -32006);
    let mut bytes = SensitiveRpcResponse::success(request.id.clone(), FixedKeyResult::Missing)
        .encode_line()
        .unwrap();
    assert!(client.deliver(&mut bytes).is_ok());
    let mut bytes = SensitiveRpcResponse::success(request.id, FixedKeyResult::Missing)
        .encode_line()
        .unwrap();
    assert!(client.deliver(&mut bytes).is_err());
}

#[test]
fn key_for_another_epoch_is_rejected_and_missing_stays_missing() {
    let (operation, client, receiver) = operation();
    let task = std::thread::spawn(move || operation.fixed_key(key_request()).err().unwrap().code);
    let request = take_request(&receiver);
    let mut stale = context();
    stale.vault_epoch = VaultEpoch::new(2).unwrap();
    deliver(&client, request.id, stale);
    assert_eq!(task.join().unwrap(), -32009);
    let (operation, client, receiver) = self::operation();
    let task = std::thread::spawn(move || operation.fixed_key(key_request()).unwrap().is_none());
    let request = take_request(&receiver);
    let mut bytes = SensitiveRpcResponse::success(request.id, FixedKeyResult::Missing)
        .encode_line()
        .unwrap();
    client.deliver(&mut bytes).unwrap();
    assert!(task.join().unwrap());
}

#[test]
fn panic_while_using_a_key_does_not_poison_its_cleanup() {
    let (operation, client, receiver) = operation();
    let task = std::thread::spawn(move || {
        let key = operation.fixed_key(key_request()).unwrap().unwrap();
        let result = catch_unwind(AssertUnwindSafe(|| {
            let _ = key.with_key::<()>(|_| panic!("business failure"));
        }));
        assert!(result.is_err());
        operation.clear_keys();
        assert!(key.with_key(|_| ()).is_err());
    });
    let request = take_request(&receiver);
    deliver(&client, request.id, context());
    task.join().unwrap();
}

#[test]
fn export_grant_validation_requires_a_true_acknowledgement() {
    let (operation, client, receiver) = operation();
    let task = std::thread::spawn(move || {
        operation
            .validate_export_grant(ExportGrantId::parse(HOST).unwrap())
            .unwrap()
    });
    let request = take_request(&receiver);
    assert_eq!(request.method, EXPORT_GRANT_METHOD);
    let mut bytes = SensitiveRpcResponse::success(request.id, true)
        .encode_line()
        .unwrap();
    client.deliver(&mut bytes).unwrap();
    task.join().unwrap();
}

#[test]
fn handshake_refuses_missing_service_identity_or_wrong_token_and_preserves_v1() {
    let mut required = ServiceCapabilities::default();
    required.0.insert(FIXED_KEY_SERVICE.into(), 1);
    let config = HostConfig {
        plugin_id: "taomni-plugin-mfa".into(),
        plugin_version: "0.1.0".into(),
        commands: BTreeSet::from(["mfa/list".into()]),
        permissions: BTreeSet::from([FIXED_KEY_SERVICE.into()]),
        required_services: required.clone(),
        optional_services: ServiceCapabilities([(CAPTURE_STILL_SERVICE.into(), 1)].into()),
        operation_timeout: Duration::from_secs(5),
        snapshot_timeout: Duration::from_secs(30),
    };
    let mut hello = HandshakeRequest::new(
        &config.plugin_id,
        &config.plugin_version,
        "token",
        vec!["mfa/list".into()],
        vec![FIXED_KEY_SERVICE.into()],
    );
    let call = |hello: &HandshakeRequest| {
        RpcRequest::new(
            "handshake",
            "plugin/handshake",
            Some(serde_json::to_value(hello).unwrap()),
        )
    };
    assert!(handshake(&call(&hello), &config, "token", None).is_err());
    hello.core_services = required;
    assert!(handshake(&call(&hello), &config, "token", None).is_err());
    hello.host_instance = Some(HostInstanceId::parse(HOST).unwrap());
    assert_eq!(
        handshake(&call(&hello), &config, "wrong", None)
            .err()
            .unwrap()
            .code,
        -32003
    );
    let (reply, instance) = handshake(&call(&hello), &config, "token", None).unwrap();
    assert_eq!(instance.unwrap().as_str(), HOST);
    assert!(reply.core_services.supports(FIXED_KEY_SERVICE, 1));
    assert!(!reply.core_services.supports(CAPTURE_STILL_SERVICE, 1));
    assert_eq!(reply.api_version, 1);
    assert_eq!(
        reply.request_id_mode,
        taomni_plugin_api::RequestIdMode::Legacy
    );
    hello.core_services.0.extend([
        (CAPTURE_STILL_SERVICE.into(), 1),
        ("unknown.service".into(), 1),
    ]);
    hello.request_id_mode = taomni_plugin_api::RequestIdMode::MonotonicV1;
    let (reply, _) = handshake(&call(&hello), &config, "token", None).unwrap();
    assert!(reply.core_services.supports(CAPTURE_STILL_SERVICE, 1));
    assert!(!reply.core_services.supports("unknown.service", 1));
    assert_eq!(
        reply.request_id_mode,
        taomni_plugin_api::RequestIdMode::MonotonicV1
    );
    hello
        .core_services
        .0
        .insert(CAPTURE_STILL_SERVICE.into(), 2);
    let (reply, _) = handshake(&call(&hello), &config, "token", None).unwrap();
    assert!(!reply.core_services.0.contains_key(CAPTURE_STILL_SERVICE));
    hello.host_instance = None;
    assert!(handshake(&call(&hello), &config, "token", None).is_err());
}

struct Fragments {
    bytes: io::Cursor<Vec<u8>>,
    size: usize,
}
impl Read for Fragments {
    fn read(&mut self, destination: &mut [u8]) -> io::Result<usize> {
        let count = destination.len().min(self.size);
        self.bytes.read(&mut destination[..count])
    }
}

#[test]
fn sensitive_line_reader_handles_fragmentation_growth_and_multiple_frames() {
    let first = "a".repeat(20_000);
    let mut reader = LineReader::new(Fragments {
        bytes: io::Cursor::new(format!("{first}\nsecond\n").into_bytes()),
        size: 13,
    });
    assert_eq!(reader.next().unwrap().unwrap().as_slice(), first.as_bytes());
    assert_eq!(reader.next().unwrap().unwrap().as_slice(), b"second");
    assert!(reader.next().unwrap().is_none());
    let mut oversized = LineReader::new(io::Cursor::new(vec![b'x'; MAX_FRAME + 1]));
    assert_eq!(
        oversized.next().unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    let mut truncated = LineReader::new(io::Cursor::new(b"unfinished"));
    assert_eq!(
        truncated.next().unwrap_err().to_string(),
        "invalid plugin control frame"
    );
}
