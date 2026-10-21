use super::applications::AppSelector;
use super::launch::AppLaunchMode;
use super::launch::AppLaunchShell;
use super::launch::is_absolute_launch_path;
use super::scope::RuleMode;
use super::scope::ScopeMode;
use super::settings::SocksCapConfig;
use super::upstream::UpstreamKind;
use super::upstream::UpstreamParams;
use super::upstream::UpstreamRef;

#[test]
fn default_roundtrip() {
    let c = SocksCapConfig::default();
    let j = serde_json::to_string(&c).unwrap();
    let mut back: SocksCapConfig = serde_json::from_str(&j).unwrap();
    back.normalize();
    assert!(matches!(back.rule_mode, RuleMode::GfwList));
    assert!(!back.bypass_cidrs.is_empty());
    assert_eq!(back.profiles.len(), 1);
    assert_eq!(back.active_profile_ids, vec!["default"]);
    assert!(back.block_quic, "block_quic defaults on");
}

#[test]
fn app_launch_mode_defaults_to_desktop_and_persists_terminal() {
    let desktop: AppSelector = serde_json::from_str(r#"{"path":"agy"}"#).unwrap();
    assert_eq!(desktop.launch_mode, AppLaunchMode::Desktop);
    assert!(desktop.launch_preparation.is_empty());
    assert!(
        !serde_json::to_string(&desktop)
            .unwrap()
            .contains("launchMode")
    );

    let mut terminal = desktop;
    terminal.launch_mode = AppLaunchMode::Terminal;
    assert!(
        serde_json::to_string(&terminal)
            .unwrap()
            .contains(r#""launchMode":"terminal""#)
    );
}

#[test]
fn launch_preparation_roundtrips_and_validates_environment_names() {
    let app: AppSelector = serde_json::from_str(
        r#"{
                "path":"./app",
                "launchPreparation": {
                    "workingDirectory":"/workspace/app",
                    "environment":{"APP_ENV":"test"},
                    "preCommand":"ulimit -n 4096",
                    "shell":"bash"
                }
            }"#,
    )
    .unwrap();
    assert_eq!(app.launch_preparation.shell, AppLaunchShell::Bash);
    assert_eq!(
        app.launch_preparation.environment.get("APP_ENV"),
        Some(&"test".to_string())
    );
    assert!(
        serde_json::to_string(&app)
            .unwrap()
            .contains("launchPreparation")
    );

    let mut config = SocksCapConfig::default();
    config.profiles[0].upstream.host = "127.0.0.1".into();
    config.profiles[0].upstream.port = 1080;
    config.profiles[0].apps = vec![app];
    config.profiles[0].apps[0]
        .launch_preparation
        .environment
        .insert("INVALID-NAME".into(), "value".into());
    assert!(config.validate().unwrap_err().contains("INVALID-NAME"));
}

#[test]
fn launch_preparation_accepts_posix_absolute_paths_on_all_hosts() {
    assert!(is_absolute_launch_path("/workspace/app"));
    assert!(!is_absolute_launch_path("workspace/app"));
}

#[test]
fn block_quic_defaults_on_for_configs_without_the_field() {
    // Old configs predate block_quic; they must load with it enabled so the
    // QUIC-leak fix applies on upgrade without a migration step.
    let old_json = r#"{
            "enabled": true,
            "profiles": [{
                "id": "p1", "name": "old",
                "upstream": {"kind": "socks5", "host": "1.2.3.4", "port": 1080}
            }],
            "activeProfileIds": ["p1"],
            "selectedProfileId": "p1"
        }"#;
    let mut cfg: SocksCapConfig = serde_json::from_str(old_json).unwrap();
    cfg.normalize();
    assert!(cfg.block_quic);
    // And an explicit false is honored.
    let off: SocksCapConfig =
        serde_json::from_str(r#"{"enabled": true, "blockQuic": false}"#).unwrap();
    assert!(!off.block_quic);
}

#[test]
fn validate_apps_empty() {
    let mut c = SocksCapConfig::default();
    c.profiles[0].mode = ScopeMode::Apps;
    c.profiles[0].upstream.host = "127.0.0.1".into();
    c.profiles[0].upstream.port = 1080;
    assert!(c.validate().is_err());
}

#[test]
fn old_config_without_params_deserializes() {
    // A config written before UpstreamParams existed must still load, with
    // params defaulting to empty and the kind preserved.
    let old_json = r#"{
            "enabled": true,
            "profiles": [{
                "id": "p1", "name": "old",
                "upstream": {"kind": "socks5", "host": "1.2.3.4", "port": 1080}
            }],
            "activeProfileIds": ["p1"],
            "selectedProfileId": "p1"
        }"#;
    let mut cfg: SocksCapConfig = serde_json::from_str(old_json).unwrap();
    cfg.normalize();
    assert_eq!(cfg.profiles[0].upstream.kind, UpstreamKind::Socks5);
    assert_eq!(cfg.profiles[0].upstream.params, UpstreamParams::default());
}

#[test]
fn xray_kind_roundtrip_preserves_params() {
    let mut up = UpstreamRef {
        kind: UpstreamKind::Vless,
        host: "example.com".into(),
        port: 443,
        ..Default::default()
    };
    up.params.uuid_ref = "vault:abc".into();
    up.params.flow = "xtls-rprx-vision".into();
    up.params.tls = "reality".into();
    up.params.reality_public_key = "PUBKEY".into();
    let j = serde_json::to_string(&up).unwrap();
    let back: UpstreamRef = serde_json::from_str(&j).unwrap();
    assert_eq!(back.kind, UpstreamKind::Vless);
    assert_eq!(back.params.uuid_ref, "vault:abc");
    assert_eq!(back.params.flow, "xtls-rprx-vision");
    assert_eq!(back.params.reality_public_key, "PUBKEY");
    // camelCase on the wire (frontend contract).
    assert!(j.contains("\"uuidRef\""));
    assert!(j.contains("\"realityPublicKey\""));
}

#[test]
fn requires_core_classifies_kinds() {
    assert!(!UpstreamKind::Http.requires_core());
    assert!(!UpstreamKind::Socks5.requires_core());
    assert!(!UpstreamKind::Ssh.requires_core());
    assert!(UpstreamKind::Shadowsocks.requires_core());
    assert!(UpstreamKind::Trojan.requires_core());
    assert!(UpstreamKind::Vmess.requires_core());
    assert!(UpstreamKind::Vless.requires_core());
    assert!(UpstreamKind::Wireguard.requires_core());
}

#[test]
fn legacy_config_migration() {
    let legacy_json = r#"{
            "enabled": true,
            "mode": "apps",
            "apps": [{"path": "C:\\game.exe", "name": "Game"}],
            "upstream": {"kind": "socks5", "host": "1.2.3.4", "port": 1080},
            "ruleMode": "proxyAll"
        }"#;
    let mut loaded: SocksCapConfig = serde_json::from_str(legacy_json).unwrap();
    loaded.normalize();
    assert_eq!(loaded.profiles.len(), 1);
    assert_eq!(loaded.profiles[0].mode, ScopeMode::Apps);
    assert_eq!(loaded.profiles[0].apps.len(), 1);
    assert_eq!(loaded.profiles[0].upstream.host, "1.2.3.4");
    assert_eq!(loaded.profiles[0].rule_mode, RuleMode::ProxyAll);
    assert!(loaded.validate().is_ok());
}

#[test]
fn gfwlist_requirement_covers_every_active_profile() {
    let mut config = SocksCapConfig::default();
    config.profiles[0].rule_mode = RuleMode::ProxyAll;
    let mut gfw = config.profiles[0].clone();
    gfw.id = "gfw".into();
    gfw.rule_mode = RuleMode::GfwList;
    gfw.priority = 10;
    config.profiles.push(gfw);
    config.active_profile_ids = vec!["default".into(), "gfw".into()];
    config.selected_profile_id = "default".into();

    assert!(config.requires_gfwlist());
    config.active_profile_ids = vec!["default".into()];
    assert!(!config.requires_gfwlist());
}
