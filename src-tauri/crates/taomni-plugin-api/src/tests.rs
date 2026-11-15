use super::*;

#[test]
fn request_round_trip_uses_json_rpc_shape() {
    let request = RpcRequest::new(
        "req-7",
        "session/connect",
        Some(serde_json::json!({ "sessionId": "s1" })),
    );
    let encoded = serde_json::to_string(&request).unwrap();
    assert_eq!(
        encoded,
        r#"{"jsonrpc":"2.0","id":"req-7","method":"session/connect","params":{"sessionId":"s1"}}"#
    );
    let decoded: RpcRequest = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, request);
}

#[test]
fn handshake_and_versions_are_camel_case_and_stable() {
    let request = HandshakeRequest::new(
        "taomni-plugin-mfa",
        "0.1.0",
        "secret",
        vec!["scan".to_owned()],
        vec!["capture.screen".to_owned()],
    );
    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(value["apiVersion"], API_VERSION);
    assert_eq!(value["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(value["pluginId"], "taomni-plugin-mfa");
    assert!(validate_versions(API_VERSION, PROTOCOL_VERSION).is_ok());
    assert_eq!(
        validate_versions(API_VERSION + 1, PROTOCOL_VERSION)
            .unwrap_err()
            .code,
        ErrorCode::ApiVersionMismatch as i32
    );
}

#[test]
fn token_validation_rejects_wrong_and_short_tokens() {
    assert!(validate_token("token", "token").is_ok());
    assert_eq!(
        validate_token("token", "tokEn").unwrap_err().code,
        ErrorCode::TokenMismatch as i32
    );
    assert_eq!(
        validate_token("token", "tok").unwrap_err().code,
        ErrorCode::TokenMismatch as i32
    );
}

#[test]
fn cancellation_and_heartbeat_are_notifications() {
    let cancel = CancelRequest {
        request_id: RequestId::Number(42),
        reason: Some("user closed tab".to_owned()),
    };
    let value = serde_json::to_value(cancel.notification()).unwrap();
    assert_eq!(value["method"], CancelRequest::METHOD);
    assert_eq!(value["params"]["requestId"], 42);
    assert!(value.get("id").is_none());

    let heartbeat = Heartbeat { timestamp_ms: 123 };
    assert_eq!(
        serde_json::to_value(heartbeat.notification()).unwrap()["method"],
        Heartbeat::METHOD
    );
}

#[test]
fn errors_round_trip_with_data_and_stable_code() {
    let error = RpcError::from_code(ErrorCode::RequestTimeout)
        .with_data(serde_json::json!({ "timeoutMs": 5000 }));
    let response = RpcResponse::failure(Some(RequestId::from("a")), error.clone());
    let decoded: RpcResponse =
        serde_json::from_value(serde_json::to_value(response).unwrap()).unwrap();
    assert_eq!(decoded.error, Some(error));
    assert_eq!(decoded.result, None);
}

#[test]
fn binary_ref_is_restricted_to_loopback_and_hash() {
    let valid = BinaryRef {
        stream_url: "ws://127.0.0.1:43521/frame".to_owned(),
        token: "one-time".to_owned(),
        content_type: "image/png".to_owned(),
        byte_len: 5,
        sha256: "0".repeat(64),
    };
    assert!(valid.validate().is_ok());
    let mut invalid = valid.clone();
    invalid.stream_url = "ws://0.0.0.0:43521/frame".to_owned();
    assert!(invalid.validate().is_err());
}
