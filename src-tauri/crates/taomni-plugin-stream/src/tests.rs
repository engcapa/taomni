use std::time::Duration;

use sha2::{Digest, Sha256};
use taomni_plugin_api::{BinaryRef, ErrorCode};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    handshake::server::{Callback, Response},
    http::{HeaderValue, StatusCode},
};

use crate::{MAX_PAYLOAD_BYTES, TransferLimits, handshake, receiver::Payload, sender::hex};

fn descriptor(bytes: &[u8]) -> BinaryRef {
    BinaryRef {
        stream_url: "ws://127.0.0.1:43521/binary/fixture".into(),
        token: "native-only-fixture".into(),
        byte_len: bytes.len() as u64,
        content_type: "application/octet-stream".into(),
        sha256: hex(&Sha256::digest(bytes)),
    }
}

#[test]
fn integrity_requires_the_entire_exact_payload_before_publication() {
    let data = descriptor(b"expected bytes");
    let mut complete = Payload::new(&data);
    complete.append(b"expected ").unwrap();
    complete.append(b"bytes").unwrap();
    assert_eq!(complete.finish().unwrap(), b"expected bytes");

    let mut truncated = Payload::new(&data);
    truncated.append(b"expected ").unwrap();
    assert_eq!(
        truncated.finish().unwrap_err().code,
        ErrorCode::InvalidRequest as i32
    );

    let mut corrupt = Payload::new(&data);
    corrupt.append(b"corrupt! bytes").unwrap();
    assert_eq!(
        corrupt.finish().unwrap_err().code,
        ErrorCode::InvalidRequest as i32
    );
}

#[test]
fn oversized_chunks_are_rejected_without_mutating_received_bytes() {
    let data = descriptor(b"safe");
    let mut payload = Payload::new(&data);
    payload.append(b"sa").unwrap();
    assert!(payload.append(b"fe-extra").is_err());
    payload.append(b"fe").unwrap();
    assert_eq!(payload.finish().unwrap(), b"safe");
}

#[test]
fn empty_binary_has_a_real_digest_and_completes_without_chunks() {
    let data = descriptor(b"");
    assert_eq!(
        data.sha256,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert!(Payload::new(&data).finish().unwrap().is_empty());
}

#[test]
fn invalid_transfer_budgets_are_rejected() {
    assert!(TransferLimits::default().validate().is_ok());
    for limits in [
        TransferLimits {
            max_bytes: 0,
            ..Default::default()
        },
        TransferLimits {
            max_bytes: MAX_PAYLOAD_BYTES + 1,
            ..Default::default()
        },
        TransferLimits {
            timeout: Duration::ZERO,
            ..Default::default()
        },
        TransferLimits {
            timeout: Duration::from_secs(301),
            ..Default::default()
        },
    ] {
        assert_eq!(
            limits.validate().unwrap_err().code,
            ErrorCode::InvalidParams as i32
        );
    }
}

#[test]
fn native_handshake_requires_exact_origin_host_path_and_one_bearer_header() {
    let url = "ws://127.0.0.1:43521/binary/fixture";
    let bearer = HeaderValue::from_static("Bearer native-only-fixture");
    let mut valid = url.into_client_request().unwrap();
    valid.headers_mut().insert("authorization", bearer.clone());
    let response = || Response::new(());
    let authorization = || handshake::Authorization {
        authority: "127.0.0.1:43521",
        path: "/binary/fixture",
        bearer: &bearer,
    };
    assert!(authorization().on_request(&valid, response()).is_ok());

    let mut attacks = Vec::new();
    for (header, value) in [
        ("origin", "tauri://localhost"),
        ("origin", "http://localhost:5000"),
        ("host", "127.0.0.1:43522"),
        ("host", "outside.invalid"),
        ("authorization", "Bearer wrong-token"),
    ] {
        let mut attack = valid.clone();
        attack
            .headers_mut()
            .insert(header, HeaderValue::from_static(value));
        attacks.push(attack);
    }
    let mut missing = valid.clone();
    missing.headers_mut().remove("authorization");
    attacks.push(missing);
    for header in ["host", "authorization"] {
        let mut duplicate = valid.clone();
        let value = duplicate.headers()[header].clone();
        duplicate.headers_mut().append(header, value);
        attacks.push(duplicate);
    }
    for uri in ["/binary/fixture?token=native-only-fixture", "/other"] {
        let mut changed = valid.clone();
        *changed.uri_mut() = uri.parse().unwrap();
        attacks.push(changed);
    }
    for attack in attacks {
        let error = authorization().on_request(&attack, response()).unwrap_err();
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert!(
            !error
                .body()
                .as_deref()
                .unwrap()
                .contains("native-only-fixture")
        );
    }
}

#[test]
fn untrusted_descriptor_limits_and_header_injection_fail_before_connecting() {
    let valid = descriptor(b"safe");
    let (address, request) = crate::receiver::prepare(&valid, TransferLimits::default()).unwrap();
    assert_eq!(address.to_string(), "127.0.0.1:43521");
    assert_eq!(
        request.headers()["authorization"],
        "Bearer native-only-fixture"
    );
    let mut attacks = Vec::new();
    let mut oversized = valid.clone();
    oversized.byte_len = MAX_PAYLOAD_BYTES as u64 + 1;
    attacks.push(oversized);
    for token in ["x".repeat(129), "token\r\nOrigin: tauri://localhost".into()] {
        let mut changed = valid.clone();
        changed.token = token;
        attacks.push(changed);
    }
    for url in [
        "ws://127.0.0.1:43521@outside.invalid/frame".into(),
        "wss://127.0.0.1:43521/frame".into(),
        format!("ws://127.0.0.1:43521/{}", "x".repeat(2048)),
    ] {
        let mut changed = valid.clone();
        changed.stream_url = url;
        attacks.push(changed);
    }
    for attack in attacks {
        assert_eq!(
            crate::receiver::prepare(&attack, TransferLimits::default())
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams as i32
        );
    }
}
