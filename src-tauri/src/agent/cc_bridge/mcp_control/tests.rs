use super::groups::normalize_group_path;
use super::groups::parent_group_path;
use super::local_targets::validate_local_shell_params;
use super::local_targets::validate_quick_connect_secret_free;
use super::parameters::LocalShellParams;
use super::parameters::SessionAuthParams;
use super::session_policy::apply_auth;
use super::session_policy::validate_secret_free_options;
use crate::session::models::AuthMethod;
use serde_json::Map;

use serde_json::json;

#[test]
fn plaintext_password_option_is_rejected() {
    let err = validate_secret_free_options(&json!({"password": "secret"})).unwrap_err();
    assert!(err.contains("plaintext secret rejected"));
    assert!(validate_secret_free_options(&json!({"passwordRef": "vault:abc"})).is_ok());
}

#[test]
fn group_paths_normalize_to_ui_format() {
    assert_eq!(
        normalize_group_path(Some("Prod / DB/Primary")).as_deref(),
        Some("Prod / DB / Primary")
    );
    assert_eq!(parent_group_path("Prod / DB"), Some("Prod".into()));
}

#[test]
fn password_auth_requires_vault_ref() {
    let mut options = Map::new();
    let auth = SessionAuthParams {
        method: "password_ref".into(),
        private_key_path: None,
        password_ref: Some("vault:one".into()),
    };
    assert!(matches!(
        apply_auth(Some(&auth), &mut options, None).unwrap(),
        AuthMethod::Password
    ));
    assert_eq!(options["passwordRef"], "vault:one");

    let bad = SessionAuthParams {
        method: "password".into(),
        private_key_path: None,
        password_ref: Some("secret".into()),
    };
    assert!(apply_auth(Some(&bad), &mut options, None).is_err());
}

#[test]
fn quick_connect_rejects_plaintext_passwords() {
    assert!(validate_quick_connect_secret_free("ssh://root:secret@example.com").is_err());
    assert!(validate_quick_connect_secret_free("ssh root:secret@example.com").is_err());
    assert!(validate_quick_connect_secret_free("ssh://root@example.com").is_ok());
    assert!(validate_quick_connect_secret_free("ssh root@example.com:22").is_ok());
}

#[test]
fn local_shell_types_are_validated() {
    assert!(
        validate_local_shell_params(&LocalShellParams {
            shell_type: Some("powershell7".into()),
            ..Default::default()
        })
        .is_ok()
    );
    assert!(
        validate_local_shell_params(&LocalShellParams {
            shell_type: Some("git bash".into()),
            ..Default::default()
        })
        .is_ok()
    );
    assert!(
        validate_local_shell_params(&LocalShellParams {
            shell_type: Some("custom".into()),
            path: Some("C:\\tools\\nu.exe".into()),
            ..Default::default()
        })
        .is_ok()
    );
    assert!(
        validate_local_shell_params(&LocalShellParams {
            shell_type: Some("custom".into()),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        validate_local_shell_params(&LocalShellParams {
            shell_type: Some("unknown".into()),
            ..Default::default()
        })
        .is_err()
    );
}
