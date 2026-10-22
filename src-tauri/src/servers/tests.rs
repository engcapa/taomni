use crate::servers::rdp;
use tauri::Manager;

use serde_json::json;

use super::{
    LOG_HISTORY_LINES, ServerRegistry, ServerType, redact_legacy_rdp_password, secure_rdp_config,
};
use crate::vault::Vault;

#[test]
fn rdp_password_is_persisted_only_as_a_vault_reference() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(&dir.path().join("vault.db")).unwrap();
    vault.init("test-master-password").unwrap();
    let mut config = json!({
        "username": "alice",
        "password": "first-secret",
        "securityMode": "hybrid"
    });

    secure_rdp_config(&vault, &mut config, None).unwrap();

    assert!(config.get("password").is_none());
    let reference = config["passwordRef"].as_str().unwrap().to_string();
    assert!(reference.starts_with("vault:"));
    assert_eq!(
        vault.resolve(&reference).unwrap().unwrap().as_str(),
        "first-secret"
    );

    config["password"] = json!("replacement-secret");
    secure_rdp_config(&vault, &mut config, None).unwrap();
    assert_eq!(config["passwordRef"].as_str(), Some(reference.as_str()));
    assert_eq!(
        vault.resolve(&reference).unwrap().unwrap().as_str(),
        "replacement-secret"
    );
}

#[test]
fn locked_legacy_config_is_redacted_before_returning_to_ui() {
    let mut config = json!({ "username": "alice", "password": "legacy-secret" });
    redact_legacy_rdp_password(&mut config);
    assert!(config.get("password").is_none());
    assert_eq!(config["credentialMigrationRequired"], true);
}

#[test]
fn log_history_keeps_the_latest_lines_per_server_until_cleared() {
    let registry = ServerRegistry::new();
    for i in 0..LOG_HISTORY_LINES + 2 {
        registry.record_log(ServerType::Rdp, &format!("rdp {i}"));
    }
    registry.record_log(ServerType::Ssh, "ssh 0");

    let history = registry.log_history();
    let rdp = &history["rdp"];
    assert_eq!(rdp.len(), LOG_HISTORY_LINES);
    assert_eq!(rdp.first().map(String::as_str), Some("rdp 2"));
    assert_eq!(
        rdp.last().map(String::as_str),
        Some(format!("rdp {}", LOG_HISTORY_LINES + 1).as_str())
    );
    assert_eq!(history["ssh"], vec!["ssh 0".to_string()]);

    registry.clear_log(ServerType::Rdp);
    let history = registry.log_history();
    assert!(!history.contains_key("rdp"));
    assert!(history.contains_key("ssh"));
}
