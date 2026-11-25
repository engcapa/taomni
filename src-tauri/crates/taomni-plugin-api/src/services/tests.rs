use super::*;
use crate::{API_VERSION, ErrorCode, PROTOCOL_VERSION, RequestId, RpcRequest};

const UUID: &str = "a1234567-1234-1234-1234-123456789abc";

fn context() -> OperationContext {
    OperationContext {
        host_instance: HostInstanceId::parse(UUID).unwrap(),
        operation: OperationId::parse(UUID).unwrap(),
        profile_generation: ProfileGeneration::parse(UUID).unwrap(),
        vault_epoch: VaultEpoch::new(7).unwrap(),
    }
}

#[test]
fn existing_rpc_wire_and_versions_are_unchanged() {
    assert_eq!((API_VERSION, PROTOCOL_VERSION), (1, 1));
    let request = RpcRequest::new(
        "old-id",
        "mfa_codes",
        Some(serde_json::json!({ "ids": [] })),
    );
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        serde_json::json!({
            "jsonrpc": "2.0", "id": "old-id", "method": "mfa_codes", "params": {"ids": []}
        })
    );
}

#[test]
fn context_round_trips_but_rejects_empty_or_noncanonical_identifiers() {
    let encoded = serde_json::to_vec(&context()).unwrap();
    assert_eq!(
        serde_json::from_slice::<OperationContext>(&encoded).unwrap(),
        context()
    );
    for value in [
        "",
        "../../vault.db",
        "00000000-0000-0000-0000-000000000000",
        "A1234567-1234-1234-1234-123456789abc",
        "a1234567_1234-1234-1234-123456789abc",
    ] {
        assert!(HostInstanceId::parse(value).is_err());
    }
    assert!(VaultEpoch::new(0).is_err());
    assert!(VaultEpoch::new(u64::MAX).unwrap().next().is_err());
    assert_eq!(VaultEpoch::new(7).unwrap().next().unwrap().get(), 8);
}

#[test]
fn fixed_key_request_cannot_smuggle_an_owner_or_replacement_key() {
    let request = ServiceRequest::new(
        RequestId::from("host-1"),
        context(),
        FixedKeyRequest {
            key_id: FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap(),
            action: FixedKeyAction::Load,
        },
    );
    let mut value = serde_json::to_value(request).unwrap();
    value["params"]["slug"] = "mfa".into();
    assert!(serde_json::from_value::<ServiceRequest<FixedKeyRequest>>(value).is_err());
    assert!(FixedKeyId::parse("mfa/../../vault").is_err());
    assert!(FixedKeyId::parse("mfa..key").is_err());
    assert!(FixedKeyId::parse("MFA.data-key-v1").is_err());
}

#[test]
fn sensitive_key_response_is_typed_and_debug_is_redacted() {
    let key = SecretKey32::new([0x6b; 32]);
    assert_eq!(format!("{key:?}"), "SecretKey32([REDACTED])");
    let result = FixedKeyResult::Key {
        context: context(),
        key,
    };
    assert_eq!(format!("{result:?}"), "FixedKeyResult::Key([REDACTED])");
    let line = SensitiveRpcResponse::success(RequestId::from("host-key-1"), result)
        .encode_line()
        .unwrap();
    assert_eq!(line.last(), Some(&b'\n'));
    #[derive(serde::Deserialize)]
    struct Reply {
        result: FixedKeyResult,
    }
    let decoded: Reply = serde_json::from_slice(line.as_slice()).unwrap();
    match decoded.result {
        FixedKeyResult::Key {
            key,
            context: actual,
        } => {
            assert_eq!(key.as_bytes(), &[0x6b; 32]);
            assert_eq!(actual, context());
        }
        FixedKeyResult::Missing => panic!("expected a typed key"),
    }
}

#[test]
fn malformed_key_errors_never_echo_the_input() {
    for invalid in [
        "secret-not-base64",
        "AAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        let encoded = format!("\"{invalid}\"");
        let error = serde_json::from_str::<SecretKey32>(&encoded).unwrap_err();
        assert!(!error.to_string().contains(invalid));
        assert!(error.to_string().contains("invalid data key"));
    }
}

#[test]
fn safe_paths_and_digests_are_cross_platform_and_bounded() {
    assert!(SafeRelativePath::parse("accounts/mfa.db").is_ok());
    for invalid in [
        "",
        "/mfa.db",
        "../vault.db",
        "a/../b",
        "a//b",
        "C:/mfa.db",
        "a\\b",
        "a/CON.db",
        "a/COM1",
        "a/file.",
        "a/file ",
        "a/\nfile",
    ] {
        assert!(SafeRelativePath::parse(invalid).is_err(), "{invalid:?}");
    }
    assert!(Sha256Digest::parse("f".repeat(64)).is_ok());
    assert!(Sha256Digest::parse("F".repeat(64)).is_err());
    assert!(Sha256Digest::parse("0".repeat(63)).is_err());
}

#[test]
fn operation_scoped_authorization_grants_are_redacted_in_request_debug() {
    let request = ExportGrantRequest {
        grant: ExportGrantId::parse(UUID).unwrap(),
    };
    assert!(!format!("{request:?}").contains(UUID));
    let reset = FixedKeyAction::RepairEmptyAfterReset {
        grant: ResetGrantId::parse(UUID).unwrap(),
    };
    assert!(!format!("{reset:?}").contains(UUID));
}

#[test]
fn denied_error_has_stable_code_and_no_key_identity() {
    let error = CoreServiceError::PermissionDenied.into_rpc_error();
    assert_eq!(error.code, ErrorCode::PermissionDenied.as_i32());
    assert_eq!(error.message, "PERMISSION_DENIED");
    assert!(error.data.is_none());
    assert_eq!(
        CoreServiceError::VaultLocked.into_rpc_error().message,
        "VAULT_LOCKED"
    );
    assert_eq!(
        CoreServiceError::Cancelled.into_rpc_error().code,
        ErrorCode::RequestCancelled.as_i32()
    );
}

#[test]
fn capabilities_are_explicit_and_exactly_versioned() {
    let mut capabilities = ServiceCapabilities::default();
    assert!(!capabilities.supports(FIXED_KEY_SERVICE, 1));
    capabilities
        .0
        .insert(FIXED_KEY_SERVICE.into(), SERVICE_VERSION);
    assert!(capabilities.supports(FIXED_KEY_SERVICE, 1));
    assert!(!capabilities.supports(FIXED_KEY_SERVICE, 2));
    assert!(!capabilities.supports(SNAPSHOT_SERVICE, 1));
}
