use super::*;
use serde_json::json;

#[test]
fn engine_key_adapter_preserves_stable_core_service_error_codes() {
    for error in [
        CoreServiceError::PermissionDenied,
        CoreServiceError::DuplicateRequest,
        CoreServiceError::VaultLocked,
        CoreServiceError::VaultBadPassword,
        CoreServiceError::VaultPasswordRequired,
        CoreServiceError::MfaKeyMissing,
        CoreServiceError::MfaKeyMismatch,
        CoreServiceError::StalePluginContext,
        CoreServiceError::PluginProfileInUse,
        CoreServiceError::CoreServiceBusy,
        CoreServiceError::Cancelled,
        CoreServiceError::TimedOut,
    ] {
        assert_eq!(business_error(error.kind()), error.into_rpc_error());
    }
    assert_eq!(
        business_error("MFA_INVALID_INPUT: invalid account").code,
        ErrorCode::InvalidParams.as_i32()
    );
    assert_eq!(
        business_error(INITIALIZATION_REQUIRED).code,
        ErrorCode::InvalidState.as_i32()
    );
}

#[test]
fn manifest_and_compiled_host_have_the_same_identity_and_service_contract() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!("../module.json")).unwrap();
    let config = host_config();
    assert_eq!(manifest["id"], config.plugin_id);
    assert_eq!(manifest["version"], config.plugin_version);
    let strings = |name: &str| {
        manifest[name]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(strings("commands"), config.commands);
    assert_eq!(strings("permissions"), config.permissions);
    assert_eq!(
        strings("vaultFixedKeys"),
        BTreeSet::from([MFA_DATA_KEY_ID.into()])
    );
    assert!(config.required_services.supports(FIXED_KEY_SERVICE, 1));
    assert!(config.optional_services.supports(CAPTURE_STILL_SERVICE, 1));
    assert_eq!(manifest["snapshot"], "rpc");
    assert_eq!(manifest["backupPaths"], json!(["plugins/mfa/data/mfa.db"]));
}

#[test]
fn export_reset_and_initialize_refuse_passwords_or_caller_chosen_capabilities() {
    let grant = "a1234567-1234-1234-1234-123456789abc";
    for (method, params) in [
        (
            "mfa_export_uri",
            json!({"id":"account","masterPassword":"do-not-forward"}),
        ),
        (
            "mfa_export_uri",
            json!({"id":"account","grant":grant,"masterPassword":"do-not-forward"}),
        ),
        ("mfa_reset_store", json!({"confirmed":true})),
        (
            "mfa_reset_store",
            json!({"grant":grant,"databaseIsEmpty":true}),
        ),
        (
            "mfa_initialize_empty",
            json!({"keyId":"other.key","databaseIsEmpty":true}),
        ),
        ("mfa_list", json!({"context":{}})),
    ] {
        assert_eq!(
            commands::parse(method, Some(params)).err().unwrap().code,
            -32602
        );
    }
    assert!(
        commands::parse(
            "mfa_export_uri",
            Some(json!({"id":"account","grant":grant}))
        )
        .is_ok()
    );
    assert!(commands::parse("mfa_reset_store", Some(json!({"grant":grant}))).is_ok());
    assert!(commands::parse("mfa_initialize_empty", None).is_ok());
    assert_eq!(
        commands::parse("vault_open", None).err().unwrap().code,
        -32601
    );
}

#[test]
fn inspecting_an_unused_profile_creates_no_mfa_data_or_database() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    assert!(paths::database(&root, false).unwrap().is_none());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    let database = paths::database(&root, true).unwrap().unwrap();
    assert_eq!(database, root.join("plugins/mfa/data/mfa.db"));
    assert!(
        !database.exists(),
        "path validation must not initialize SQLite"
    );
}

#[cfg(unix)]
#[test]
fn linked_data_parents_database_and_sidecars_are_rejected_without_touching_targets() {
    use std::{fs, os::unix::fs::symlink};
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let target = outside.path().join("sensitive-file");
    fs::write(&target, b"must remain unchanged").unwrap();
    symlink(outside.path(), root.join("plugins")).unwrap();
    assert!(paths::database(&root, true).is_err());
    assert!(!outside.path().join("mfa").exists());
    fs::remove_file(root.join("plugins")).unwrap();
    let database = paths::database(&root, true).unwrap().unwrap();
    for path in [
        &database,
        &database.with_file_name("mfa.db-wal"),
        &database.with_file_name("mfa.db-shm"),
    ] {
        symlink(&target, path).unwrap();
        assert!(paths::database(&root, true).is_err());
        fs::remove_file(path).unwrap();
        fs::hard_link(&target, path).unwrap();
        assert!(paths::database(&root, true).is_err());
        fs::remove_file(path).unwrap();
    }
    assert_eq!(fs::read(target).unwrap(), b"must remain unchanged");
}
