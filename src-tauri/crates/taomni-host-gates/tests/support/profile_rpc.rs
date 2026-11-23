//! Read the real SDK's replies from a fixture process with a bounded wait.

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc::{Receiver, sync_channel},
    time::Duration,
};

use serde_json::json;
use sha2::{Digest, Sha256};
use taomni_plugin_api::{
    ErrorCode, HandshakeRequest, HandshakeResponse, RequestIdMode, RpcRequest, RpcResponse,
    services::{HOST_PROFILE_ENV, HostInstanceId, HostProfileContext},
};

use super::{Fixture, support};

const FIXTURE_TOKEN: &str = "profile-rpc-contract";

struct Peer {
    child: Child,
    replies: Receiver<String>,
}

impl Peer {
    fn start(fixture: &Fixture, context: &HostProfileContext) -> Self {
        let mut child = Command::new(support::hello())
            .env("TAOMNI_PLUGIN_TOKEN", FIXTURE_TOKEN)
            .env(
                HOST_PROFILE_ENV,
                json!({"root": fixture.root.path(), "context": context}).to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start the profiled hello SDK host");
        let stdout = child.stdout.take().expect("SDK response pipe");
        let (sender, replies) = sync_channel(1);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Self { child, replies }
    }

    fn call(&mut self, request: RpcRequest) -> RpcResponse {
        let input = self.child.stdin.as_mut().expect("SDK request pipe");
        serde_json::to_writer(&mut *input, &request).expect("write SDK request");
        input.write_all(b"\n").expect("end SDK request frame");
        input.flush().expect("flush SDK request pipe");
        let line = self
            .replies
            .recv_timeout(Duration::from_secs(10))
            .expect("receive the SDK's correlated response");
        let response: RpcResponse = serde_json::from_str(&line).expect("decode SDK response");
        assert_eq!(response.id, Some(request.id));
        response
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn record_receipt() {
    let Some(root) = std::env::var_os("TAOMNI_GATE_EVIDENCE_DIR").map(PathBuf::from) else {
        return;
    };
    let source =
        fs::read_to_string(root.join("source-sha.txt")).expect("read the hosted source SHA");
    let binary = fs::read(support::hello()).expect("read the exact executed host binary");
    let receipt = json!({
        "schema": "taomni.qa.sdk-rpc.v1",
        "sourceSha": source.trim(),
        "hostSha256": format!("{:x}", Sha256::digest(binary)),
        "runner": {
            "image": std::env::var("ImageOS").ok(),
            "version": std::env::var("ImageVersion").ok(),
            "architecture": std::env::var("RUNNER_ARCH").ok(),
        },
        "cases": {
            "incompatibleProtocol": ErrorCode::ProtocolVersionMismatch.as_i32(),
            "undeclaredPermission": ErrorCode::PermissionDenied.as_i32(),
            "undeclaredCommand": ErrorCode::MethodNotFound.as_i32(),
            "duplicateRequest": ErrorCode::DuplicateRequest.as_i32(),
            "committedWrites": 1,
        },
    });
    fs::write(
        root.join("profile-rpc-receipt.json"),
        serde_json::to_vec_pretty(&receipt).expect("serialize the hosted SDK receipt"),
    )
    .expect("retain the hosted SDK receipt");
}

#[test]
#[ignore = "real SDK stdio contract: GitHub runners only"]
fn real_sdk_rejects_incompatible_and_duplicate_requests_without_repeating_a_write() {
    let fixture = Fixture::new();
    let context = HostProfileContext {
        owner: Fixture::owner().as_str().into(),
        generation: Fixture::generation(),
    };
    let instance = HostInstanceId::parse("a1234567-1234-1234-1234-123456789abc").unwrap();
    let mut handshake = HandshakeRequest::new(
        "taomni-plugin-hello-plugin",
        "0.1.0",
        FIXTURE_TOKEN,
        Fixture::commands(),
        vec![],
    );
    handshake.profile = Some(context.clone());
    handshake.host_instance = Some(instance.clone());
    handshake.request_id_mode = RequestIdMode::MonotonicV1;
    let mut peer = Peer::start(&fixture, &context);

    let handshake_request = |id, value| {
        RpcRequest::new(
            id,
            "plugin/handshake",
            Some(serde_json::to_value(value).expect("serialize fixture handshake")),
        )
    };
    let mut incompatible = handshake.clone();
    incompatible.protocol_version += 1;
    assert_eq!(
        peer.call(handshake_request("incompatible", incompatible))
            .error
            .unwrap()
            .code,
        ErrorCode::ProtocolVersionMismatch.as_i32(),
    );
    let mut undeclared_grant = handshake.clone();
    undeclared_grant.permissions.push("capture.screen".into());
    assert_eq!(
        peer.call(handshake_request("undeclared-grant", undeclared_grant))
            .error
            .unwrap()
            .code,
        ErrorCode::PermissionDenied.as_i32(),
    );
    let accepted: HandshakeResponse = serde_json::from_value(
        peer.call(handshake_request("handshake", handshake))
            .result
            .unwrap(),
    )
    .unwrap();
    assert!(accepted.accepted);
    assert_eq!(accepted.request_id_mode, RequestIdMode::MonotonicV1);
    assert_eq!(accepted.profile, Some(context));

    let request = |sequence, method, params| {
        RpcRequest::new(format!("core/{instance}/{sequence}"), method, params)
    };
    assert_eq!(
        peer.call(request(1, "hello/unregistered", None))
            .error
            .unwrap()
            .code,
        ErrorCode::MethodNotFound.as_i32(),
    );
    let value = Some(json!({"value": "one committed write"}));
    let write = request(2, "hello/write", value);
    let expected = json!({"values": ["one committed write"]});
    assert_eq!(peer.call(write.clone()).result, Some(expected.clone()));
    assert_eq!(
        peer.call(write).error.unwrap().code,
        ErrorCode::DuplicateRequest.as_i32(),
    );
    assert_eq!(
        peer.call(request(3, "hello/read", None)).result,
        Some(expected)
    );
    drop(peer);
    fixture.assert_released();
    record_receipt();
}
