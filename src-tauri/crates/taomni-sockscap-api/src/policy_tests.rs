use super::*;
use crate::gfwlist_rules::CompiledRules;
use crate::{
    AppSelector, Decision, RuleMode, ScopeMode, SocksCapConfig, SocksCapProfile, UserRule,
};

fn cfg_gfw() -> SocksCapConfig {
    let mut c = SocksCapConfig::default();
    c.profiles[0].upstream.host = "127.0.0.1".into();
    c.profiles[0].upstream.port = 1080;
    c
}

#[test]
fn serialized_target_probe_matches_the_relay_without_upstream_credentials() {
    let mut config = cfg_gfw();
    config.profiles[0].upstream.password_ref = "vault:private-reference".into();
    config.profiles[0].user_rules.push(UserRule {
        pattern: "block.example.test".into(),
        action: UserRuleAction::Block,
        comment: String::new(),
    });
    let mut app_only = config.profiles[0].clone();
    app_only.id = "apps".into();
    app_only.priority = -10;
    app_only.mode = ScopeMode::Apps;
    app_only.rule_mode = RuleMode::ProxyAll;
    config.profiles.push(app_only);
    config.active_profile_ids.push("apps".into());
    let rules = CompiledRules::compile("||match.example.test\n", "test").unwrap();
    let engine = PolicyEngine::from_config(&config, Some(&rules));

    for host in [
        "127.0.0.2",
        "MATCH.example.test.",
        "block.example.test",
        "miss.example.test",
    ] {
        let input = PolicyInput {
            host: Some(host.into()),
            ip: host.parse().ok(),
            port: 443,
            process_path: None,
            pid: None,
        };
        let expected = engine.decide(&input);
        let probe = TargetRuleProbe::for_config(&config, Some(&rules), host.into(), 443);
        let payload = serde_json::to_string(&probe).unwrap();
        assert!(!payload.contains("private-reference"));
        let received: TargetRuleProbe = serde_json::from_str(&payload).unwrap();
        let actual = received.evaluate();
        assert_eq!(actual.host, host);
        assert_eq!(actual.port, 443);
        assert_eq!(actual.decision, expected.decision);
        assert_eq!(actual.reason, expected.reason);
        assert_eq!(actual.matched_rule, expected.matched_rule);
    }
}

#[test]
fn bypass_private() {
    let eng = PolicyEngine::from_config(&cfg_gfw(), None);
    let t = eng.decide(&PolicyInput {
        host: None,
        ip: Some("192.168.1.1".parse().unwrap()),
        port: 80,
        process_path: None,
        pid: None,
    });
    assert!(matches!(t.decision, Decision::Direct));
}

#[test]
fn gfwlist_proxy_and_default() {
    let sample = "||google.com\n";
    let rules = CompiledRules::compile(sample, "t").unwrap();
    let eng = PolicyEngine::from_config(&cfg_gfw(), Some(&rules));
    let hit = eng.decide(&PolicyInput {
        host: Some("www.google.com".into()),
        ip: None,
        port: 443,
        process_path: None,
        pid: None,
    });
    assert!(matches!(hit.decision, Decision::Proxy));
    assert_eq!(hit.profile_id.as_deref(), Some("default"));
    let miss = eng.decide(&PolicyInput {
        host: Some("example.cn".into()),
        ip: None,
        port: 443,
        process_path: None,
        pid: None,
    });
    assert!(matches!(miss.decision, Decision::Direct));
}

#[test]
fn hostname_free_decisions_skip_sniff_only_when_safe() {
    let mut config = cfg_gfw();
    let input = PolicyInput {
        host: None,
        ip: Some("8.8.8.8".parse().unwrap()),
        port: 443,
        process_path: None,
        pid: None,
    };
    let gfw = PolicyEngine::from_config(&config, None);
    assert!(gfw.decide_without_hostname(&input, None).is_none());

    config.profiles[0].rule_mode = RuleMode::ProxyAll;
    let proxy_all = PolicyEngine::from_config(&config, None);
    assert!(matches!(
        proxy_all
            .decide_without_hostname(&input, None)
            .unwrap()
            .decision,
        Decision::Proxy
    ));

    config.profiles[0].user_rules.push(UserRule {
        pattern: "example.com".into(),
        action: UserRuleAction::Direct,
        comment: String::new(),
    });
    let domain_override = PolicyEngine::from_config(&config, None);
    assert!(
        domain_override
            .decide_without_hostname(&input, None)
            .is_none()
    );
}

#[test]
fn bypass_ip_never_waits_for_a_hostname() {
    let engine = PolicyEngine::from_config(&cfg_gfw(), None);
    let trace = engine
        .decide_without_hostname(
            &PolicyInput {
                host: None,
                ip: Some("192.168.0.110".parse().unwrap()),
                port: 31028,
                process_path: None,
                pid: None,
            },
            None,
        )
        .unwrap();
    assert!(matches!(trace.decision, Decision::Direct));
}

#[test]
fn multi_profile_priority() {
    let mut c = SocksCapConfig::default();
    let p1 = SocksCapProfile {
        id: "game".into(),
        name: "Game".into(),
        icon: None,
        color: None,
        enabled: true,
        priority: 0,
        mode: ScopeMode::Apps,
        apps: vec![AppSelector {
            path: "C:\\Apex.exe".into(),
            args: Vec::new(),
            launch_mode: Default::default(),
            launch_preparation: Default::default(),
            bundle_id: "".into(),
            name: "Apex".into(),
            macos_identity: None,
        }],
        upstream: Default::default(),
        rule_mode: RuleMode::ProxyAll,
        user_rules: vec![],
        default_action: Decision::Proxy,
    };
    let p2 = SocksCapProfile {
        id: "dev".into(),
        name: "Dev".into(),
        icon: None,
        color: None,
        enabled: true,
        priority: 1,
        mode: ScopeMode::Apps,
        apps: vec![AppSelector {
            path: "C:\\VSCode.exe".into(),
            args: Vec::new(),
            launch_mode: Default::default(),
            launch_preparation: Default::default(),
            bundle_id: "".into(),
            name: "VSCode".into(),
            macos_identity: None,
        }],
        upstream: Default::default(),
        rule_mode: RuleMode::Off,
        user_rules: vec![],
        default_action: Decision::Direct,
    };
    c.profiles = vec![p1, p2];
    c.active_profile_ids = vec!["game".into(), "dev".into()];

    let eng = PolicyEngine::from_config(&c, None);

    // Apex.exe should match Game profile
    let t1 = eng.decide(&PolicyInput {
        host: Some("apex.com".into()),
        ip: None,
        port: 443,
        process_path: Some("C:\\Apex.exe".into()),
        pid: None,
    });
    assert!(matches!(t1.decision, Decision::Proxy));
    assert_eq!(t1.profile_name.as_deref(), Some("Game"));

    // VSCode.exe should match Dev profile
    let t2 = eng.decide(&PolicyInput {
        host: Some("github.com".into()),
        ip: None,
        port: 443,
        process_path: Some("C:\\VSCode.exe".into()),
        pid: None,
    });
    assert!(matches!(t2.decision, Decision::Direct));
    assert_eq!(t2.profile_name.as_deref(), Some("Dev"));

    // Unmatched process should be Direct
    let t3 = eng.decide(&PolicyInput {
        host: Some("baidu.com".into()),
        ip: None,
        port: 443,
        process_path: Some("C:\\Notepad.exe".into()),
        pid: None,
    });
    assert!(matches!(t3.decision, Decision::Direct));
    assert_eq!(t3.profile_name, None);
}

#[test]
fn linux_profile_hint_scopes_app_flow_without_process_path() {
    let mut config = SocksCapConfig::default();
    config.profiles[0].mode = ScopeMode::Apps;
    config.profiles[0].apps = vec![AppSelector {
        path: "/opt/example/example".into(),
        args: Vec::new(),
        launch_mode: Default::default(),
        launch_preparation: Default::default(),
        bundle_id: String::new(),
        name: "Example".into(),
        macos_identity: None,
    }];
    config.profiles[0].rule_mode = RuleMode::ProxyAll;
    let engine = PolicyEngine::from_config(&config, None);
    let trace = engine.decide_with_profile_hint(
        &PolicyInput {
            host: Some("example.com".into()),
            ip: None,
            port: 443,
            process_path: None,
            pid: None,
        },
        Some("default"),
    );
    assert_eq!(trace.decision, Decision::Proxy);
    assert_eq!(trace.profile_id.as_deref(), Some("default"));
}

#[test]
fn linux_mixed_relays_preserve_app_priority_and_global_fallback() {
    let mut config = SocksCapConfig::default();
    config.profiles[0].id = "agy".into();
    config.profiles[0].name = "agy".into();
    config.profiles[0].mode = ScopeMode::Apps;
    config.profiles[0].apps = vec![AppSelector {
        path: "/opt/agy/agy".into(),
        args: Vec::new(),
        launch_mode: Default::default(),
        launch_preparation: Default::default(),
        bundle_id: String::new(),
        name: "agy".into(),
        macos_identity: None,
    }];
    config.profiles[0].rule_mode = RuleMode::ProxyAll;

    let mut global = config.profiles[0].clone();
    global.id = "global".into();
    global.name = "Global GFWList".into();
    global.priority = 1;
    global.mode = ScopeMode::Global;
    global.apps.clear();
    global.rule_mode = RuleMode::GfwList;
    config.profiles.push(global);
    config.active_profile_ids = vec!["agy".into(), "global".into()];

    let rules = CompiledRules::compile("||wikipedia.org\n", "test").unwrap();
    let engine = PolicyEngine::from_config(&config, Some(&rules));
    let input = PolicyInput {
        host: Some("en.wikipedia.org".into()),
        ip: None,
        port: 443,
        process_path: None,
        pid: None,
    };

    let app = engine.decide_with_profile_hint(&input, Some("agy"));
    assert_eq!(app.decision, Decision::Proxy);
    assert_eq!(app.profile_id.as_deref(), Some("agy"));

    let fallback = engine.decide_with_profile_hint(&input, None);
    assert_eq!(fallback.decision, Decision::Proxy);
    assert_eq!(fallback.profile_id.as_deref(), Some("global"));
}
