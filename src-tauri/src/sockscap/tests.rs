#[cfg(target_os = "macos")]
use super::pending_approval_never_recorded_scope;
use super::{
    Orchestrator, classify_client, ensure_configuration_unlocked, session_password_ref,
    session_proxy_password, session_ssh_auth, should_block_exit_for_recovery,
};
#[cfg(target_os = "linux")]
use super::{linux_recovery_requires_elevation, should_recover_stale_capture_for_update};
use crate::session::models::{AuthMethod, SessionConfig, SessionType};
#[cfg(target_os = "macos")]
use crate::sockscap::recovery::{RecoveryJournal, RecoveryPhase};
use crate::terminal::ssh::SshAuth;
use crate::vault::Vault;

fn proxy_session(options_json: &str) -> SessionConfig {
    SessionConfig {
        id: "proxy-1".into(),
        name: "SOCKS5 upstream".into(),
        session_type: SessionType::Proxy,
        group_path: None,
        host: "10.0.0.9".into(),
        port: 1080,
        username: Some("alice".into()),
        auth_method: AuthMethod::Password,
        options_json: options_json.into(),
        created_at: 0,
        updated_at: 0,
        last_connected_at: None,
        sort_order: 0,
    }
}

fn fresh_vault() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = Vault::open(&dir.path().join("vault.db")).expect("open vault");
    vault
        .init("correct-horse-battery-staple")
        .expect("init vault");
    (dir, vault)
}

#[test]
fn configuration_mutations_are_rejected_during_capture() {
    let mut orchestrator = Orchestrator::new();
    assert!(ensure_configuration_unlocked(&orchestrator).is_ok());

    orchestrator.set_active("test", "active");
    let error = ensure_configuration_unlocked(&orchestrator).unwrap_err();
    assert!(error.contains("stop capture before making changes"));

    orchestrator.finish_stop();
    assert!(ensure_configuration_unlocked(&orchestrator).is_ok());
}

#[test]
fn stale_recovery_journal_without_owned_capture_does_not_block_exit() {
    assert!(!should_block_exit_for_recovery(true, false));
    assert!(should_block_exit_for_recovery(true, true));
    assert!(!should_block_exit_for_recovery(false, true));
}

#[cfg(target_os = "linux")]
#[test]
fn stale_linux_capture_is_recovered_during_update_preparation() {
    assert!(should_recover_stale_capture_for_update(false, true, true));
    assert!(should_recover_stale_capture_for_update(false, false, true));
    assert!(!should_recover_stale_capture_for_update(true, true, true));
    assert!(!should_recover_stale_capture_for_update(
        false, false, false
    ));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_update_recovery_requests_sudo_only_for_permission_failures() {
    assert!(linux_recovery_requires_elevation(
        "query nftables table failed: Operation not permitted. Linux capture requires CAP_NET_ADMIN"
    ));
    assert!(linux_recovery_requires_elevation(
        "Linux cgroup cleanup requires root or delegated cgroup v2 permissions"
    ));
    assert!(!linux_recovery_requires_elevation(
        "an nftables table named taomni_sockscap is not recognized as SocksCap-owned"
    ));
}

#[test]
fn password_ref_extracted_from_options_json() {
    assert_eq!(
        session_password_ref(r#"{"proxyKind":"socks5","passwordRef":"vault:abc"}"#),
        Some("vault:abc".to_string())
    );
}

#[test]
fn password_ref_absent_or_blank_is_none() {
    assert_eq!(session_password_ref(r#"{"proxyKind":"socks5"}"#), None);
    assert_eq!(session_password_ref(r#"{"passwordRef":"   "}"#), None);
    assert_eq!(session_password_ref("not json"), None);
}

#[test]
fn session_password_resolves_vault_reference() {
    let (_dir, vault) = fresh_vault();
    let reference = vault
        .put("sockscap-upstream", "alice@proxy", "s3cret")
        .expect("put")
        .reference;
    let options = format!(r#"{{"proxyKind":"socks5","passwordRef":"{reference}"}}"#);
    assert_eq!(
        session_proxy_password(&vault, &proxy_session(&options)),
        Some("s3cret".to_string())
    );
}

#[test]
fn session_without_password_ref_returns_none() {
    let (_dir, vault) = fresh_vault();
    assert_eq!(
        session_proxy_password(&vault, &proxy_session(r#"{"proxyKind":"socks5"}"#)),
        None
    );
}

#[test]
fn non_reference_password_treated_as_literal() {
    // Backwards-compat: a plaintext value in passwordRef is used as-is.
    let (_dir, vault) = fresh_vault();
    assert_eq!(
        session_proxy_password(&vault, &proxy_session(r#"{"passwordRef":"plain-pass"}"#)),
        Some("plain-pass".to_string())
    );
}

#[test]
fn locked_vault_swallows_error_and_returns_none() {
    let (_dir, vault) = fresh_vault();
    let reference = vault
        .put("sockscap-upstream", "alice@proxy", "s3cret")
        .expect("put")
        .reference;
    vault.lock().expect("lock");
    let options = format!(r#"{{"passwordRef":"{reference}"}}"#);
    assert_eq!(
        session_proxy_password(&vault, &proxy_session(&options)),
        None
    );
}

fn ssh_session(auth_method: AuthMethod, options_json: &str) -> SessionConfig {
    SessionConfig {
        id: "ssh-1".into(),
        name: "SSH upstream".into(),
        session_type: SessionType::SSH,
        group_path: None,
        host: "bastion.example".into(),
        port: 22,
        username: Some("bob".into()),
        auth_method,
        options_json: options_json.into(),
        created_at: 0,
        updated_at: 0,
        last_connected_at: None,
        sort_order: 0,
    }
}

#[test]
fn ssh_private_key_session_uses_key_path() {
    let (_dir, vault) = fresh_vault();
    let session = ssh_session(
        AuthMethod::PrivateKey {
            key_path: "~/.ssh/id_ed25519".into(),
        },
        "{}",
    );
    match session_ssh_auth(&vault, &session) {
        SshAuth::PrivateKey(path) => assert_eq!(path, "~/.ssh/id_ed25519"),
        other => panic!("expected PrivateKey, got {}", auth_label(&other)),
    }
}

#[test]
fn ssh_password_session_resolves_vault_password() {
    let (_dir, vault) = fresh_vault();
    let reference = vault
        .put("ssh-password", "bob@bastion", "hunter2")
        .expect("put")
        .reference;
    let options = format!(r#"{{"passwordRef":"{reference}"}}"#);
    let session = ssh_session(AuthMethod::Password, &options);
    match session_ssh_auth(&vault, &session) {
        SshAuth::Password(p) => assert_eq!(p, "hunter2"),
        other => panic!("expected Password, got {}", auth_label(&other)),
    }
}

#[test]
fn ssh_agent_and_passwordless_sessions_fall_back_to_agent() {
    let (_dir, vault) = fresh_vault();
    assert!(matches!(
        session_ssh_auth(&vault, &ssh_session(AuthMethod::Agent, "{}")),
        SshAuth::Agent
    ));
    // Password auth but no stored secret → agent, not an empty password.
    assert!(matches!(
        session_ssh_auth(&vault, &ssh_session(AuthMethod::Password, "{}")),
        SshAuth::Agent
    ));
    // Keyless PrivateKey (blank path) → agent rather than an empty key path.
    assert!(matches!(
        session_ssh_auth(
            &vault,
            &ssh_session(
                AuthMethod::PrivateKey {
                    key_path: "  ".into()
                },
                "{}"
            )
        ),
        SshAuth::Agent
    ));
}

fn auth_label(auth: &SshAuth) -> &'static str {
    match auth {
        SshAuth::Password(_) => "Password",
        SshAuth::PrivateKey(_) => "PrivateKey",
        SshAuth::Agent => "Agent",
    }
}

#[test]
fn classify_client_maps_known_families() {
    // (process image name, expected id, expected label)
    let cases = [
        ("Clash Verge.exe", "clash", "Clash Verge"),
        ("clash-verge", "clash", "Clash Verge"),
        ("Clash for Windows.exe", "clash", "Clash"),
        ("clash-meta", "clash", "Clash"),
        ("mihomo", "mihomo", "Mihomo"),
        ("verge-mihomo.exe", "mihomo", "Mihomo"), // mihomo wins over verge
        ("sing-box.exe", "sing-box", "sing-box"),
        ("sing_box", "sing-box", "sing-box"),
        ("v2rayN.exe", "v2rayn", "v2rayN"),
        ("nekoray.exe", "nekoray", "NekoRay"),
        ("qv2ray", "qv2ray", "Qv2ray"),
        ("xray.exe", "xray", "Xray"),
        ("v2ray", "v2ray", "V2Ray"),
        ("hysteria.exe", "hysteria", "Hysteria"),
        ("sslocal", "shadowsocks", "Shadowsocks"),
    ];
    for (name, id, label) in cases {
        let (got_id, got_label) = classify_client(name);
        assert_eq!(got_id, id, "id for {name}");
        assert_eq!(got_label, label, "label for {name}");
    }
}

#[test]
fn classify_client_unknown_has_empty_label() {
    for name in ["chrome.exe", "node", "", "postgres", "svchost.exe"] {
        let (id, label) = classify_client(name);
        assert_eq!(id, "unknown", "unexpected id for {name}");
        assert!(label.is_empty(), "unexpected label for {name}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn only_unapplied_preparing_journal_can_clear_during_pending_approval() {
    let mut journal = RecoveryJournal {
        platform: "macos".into(),
        capture_backend: "mitmproxy-redirector".into(),
        config_hash: "hash".into(),
        pid: 1,
        clean: false,
        phase: RecoveryPhase::Preparing,
        session_id: "session".into(),
        backend_version: Some("0.12.11".into()),
        scope_hash: None,
        bridge_pid: None,
        provider_pid: None,
        relay_port: None,
        helper_port: None,
    };
    assert!(pending_approval_never_recorded_scope(&journal));

    journal.scope_hash = Some("scope".into());
    assert!(!pending_approval_never_recorded_scope(&journal));
    journal.scope_hash = None;
    journal.phase = RecoveryPhase::Active;
    assert!(!pending_approval_never_recorded_scope(&journal));
}
