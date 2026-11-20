use std::collections::BTreeSet;

use serde_json::json;

use super::*;

#[test]
fn compiled_identity_matches_the_stateless_module_manifest() {
    let manifest: Value = serde_json::from_str(include_str!("../module.json")).unwrap();
    let config = host_config();
    let commands: BTreeSet<String> = serde_json::from_value(manifest["commands"].clone()).unwrap();
    assert_eq!(manifest["id"], config.plugin_id);
    assert_eq!(manifest["version"], config.plugin_version);
    assert_eq!(manifest["entry"]["host"], config.plugin_id);
    assert_eq!(commands, config.commands);
    assert_eq!(manifest["backupPaths"], json!([]));
    assert!(config.permissions.is_empty());
}

#[test]
fn rejects_invalid_endpoints_and_caller_selected_proxy_hosts() {
    for input in [
        json!({"host":"","port":5900}),
        json!({"host":"vnc.example","port":0}),
        json!({"host":"vnc.example","port":5900,"forwardPort":0}),
        json!({"host":"vnc.example","port":5900,"forwardHost":"outside.example"}),
    ] {
        let result =
            request::decode::<request::Start>(Some(input)).and_then(request::Start::checked);
        assert!(matches!(result, Err(error) if error.code == ErrorCode::InvalidParams.as_i32()));
    }
}

#[test]
fn closing_an_unknown_session_does_not_allocate_resources() {
    let sessions = sessions::Sessions::new().unwrap();
    assert!(
        !sessions
            .close("a1234567-1234-1234-1234-123456789abc")
            .unwrap()
    );
    assert_eq!(
        sessions.close("invalid").unwrap_err().code,
        ErrorCode::InvalidParams.as_i32(),
    );
}
