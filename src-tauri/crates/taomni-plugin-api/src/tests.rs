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
fn service_fields_are_additive_and_leave_legacy_payloads_unchanged() {
    let old = r#"{"apiVersion":1,"protocolVersion":1,"pluginId":"hello","pluginVersion":"0.1.0","token":"t"}"#;
    let old: HandshakeRequest = serde_json::from_str(old).unwrap();
    assert!(old.core_services.is_empty());
    assert!(
        serde_json::to_value(old)
            .unwrap()
            .get("coreServices")
            .is_none()
    );
    let old: HandshakeResponse =
        serde_json::from_str(r#"{"apiVersion":1,"protocolVersion":1,"accepted":true}"#).unwrap();
    assert!(old.core_services.is_empty());
    let mut request = RpcRequest::new("call", "mfa/list", Some(serde_json::json!({"filter":"a"})));
    let context: services::OperationContext = serde_json::from_value(serde_json::json!({
        "hostInstance":"a1234567-1234-1234-1234-123456789abc",
        "operation":"b1234567-1234-1234-1234-123456789abc",
        "profileGeneration":"c1234567-1234-1234-1234-123456789abc", "vaultEpoch":1
    }))
    .unwrap();
    request.context = Some(context.clone());
    let encoded = serde_json::to_value(&request).unwrap();
    assert_eq!(encoded["params"], serde_json::json!({"filter":"a"}));
    assert_eq!(
        serde_json::from_value::<RpcRequest>(encoded)
            .unwrap()
            .context,
        Some(context)
    );
    let mut response = HandshakeResponse::accepted(1000);
    response
        .core_services
        .0
        .insert(services::FIXED_KEY_SERVICE.into(), 1);
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["coreServices"]["vault.fixed-key"], 1);
    assert_eq!(API_VERSION, 1);
    assert_eq!(PROTOCOL_VERSION, 1);
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
fn successful_null_result_is_distinct_from_a_missing_result_on_the_wire() {
    let response = RpcResponse::success("mfa-initialize", Value::Null);
    let wire = serde_json::to_string(&RpcMessage::Response(response.clone())).unwrap();
    assert!(wire.contains("\"result\":null"));
    let decoded: RpcMessage = serde_json::from_str(&wire).unwrap();
    assert_eq!(decoded, RpcMessage::Response(response));
    let absent: RpcResponse =
        serde_json::from_str(r#"{"jsonrpc":"2.0","id":"missing-result"}"#).unwrap();
    assert!(absent.result.is_none());
    assert!(absent.error.is_none());
    for invalid in [
        r#"{"jsonrpc":"2.0","id":"a","error":null}"#,
        r#"{"jsonrpc":"2.0","id":"a","result":null,"error":null}"#,
    ] {
        assert!(serde_json::from_str::<RpcResponse>(invalid).is_err());
    }
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
