use super::*;
use serde_json::json;

#[test]
fn defaults_are_restricted_and_legacy_host_files_still_load() {
    let dir = tempfile::tempdir().unwrap();
    let policy = HostPolicy::load(dir.path(), 8787, false).unwrap();
    assert_eq!(policy.config, ListenerConfig::default());
    assert!(policy.allows("localhost:8787"));
    assert!(policy.allows("127.0.0.1:8787"));
    assert!(!policy.allows("localhost:8788"));
    assert!(!policy.allows("evil.example:8787"));
    std::fs::write(
        dir.path().join("mobile-listener.json"),
        r#"{"allowed_hosts":["pc.example.com","proxy_host.example:8443"]}"#,
    )
    .unwrap();
    let policy = HostPolicy::load(dir.path(), 8787, false).unwrap();
    assert!(!policy.config.allow_all_hosts);
    assert!(policy.allows("pc.example.com"));
    assert!(policy.allows("proxy_host.example:8443"));
    assert!(!policy.allows("pc.example.com:8443"));
    assert!(!policy.allows("other.pc.example.com"));
}

#[test]
fn normalization_and_atomic_roundtrip_preserve_explicit_hosts_in_allow_all_mode() {
    let dir = tempfile::tempdir().unwrap();
    let config = ListenerConfig {
        allowed_hosts: vec![
            " PC.Example.COM ".into(),
            "pc.example.com".into(),
            "pc.example.com:8443".into(),
            "[::1]:8787".into(),
        ],
        allow_all_hosts: true,
    };
    config.save(dir.path()).unwrap();
    let loaded = ListenerConfig::load(dir.path()).unwrap();
    assert_eq!(
        loaded.allowed_hosts,
        ["pc.example.com", "pc.example.com:8443", "[::1]:8787"]
    );
    assert!(loaded.allow_all_hosts);
    let mut policy = HostPolicy::load(dir.path(), 8787, false).unwrap();
    assert!(policy.allows("unlisted.example:12345"));
    assert!(!policy.allows(""));
    policy.config.allow_all_hosts = false;
    policy.config.save(dir.path()).unwrap();
    let restored = HostPolicy::load(dir.path(), 8787, false).unwrap();
    assert!(!restored.allows("unlisted.example:12345"));
    assert!(restored.allows("pc.example.com"));
    assert!(restored.allows("[::1]:8787"));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn invalid_authorities_cannot_replace_a_working_config_even_in_allow_all_mode() {
    let dir = tempfile::tempdir().unwrap();
    ListenerConfig::default().save(dir.path()).unwrap();
    let before = std::fs::read(dir.path().join("mobile-listener.json")).unwrap();
    for host in [
        "",
        "https://pc.example.com",
        "pc.example.com/",
        "pc.example.com?x=1",
        "user@pc.example.com",
        "*.example.com",
        "*",
        "pc.example.com:",
        "pc.example.com:65536",
        "pc.example.com:abc",
        "pc example.com",
        "-bad.example",
        "bad-.example",
        "a..example",
        "[not-ipv6]:8787",
        "[::1]junk:8787",
        "[::1]junk",
        "pc.example.com:+443",
        "pc.example.com..",
        "::1",
    ] {
        let config = ListenerConfig {
            allowed_hosts: vec![host.into()],
            allow_all_hosts: true,
        };
        assert_eq!(
            config.save(dir.path()).unwrap_err(),
            "invalid_mobile_host",
            "{host}"
        );
        assert_eq!(
            std::fs::read(dir.path().join("mobile-listener.json")).unwrap(),
            before
        );
    }
    let config = ListenerConfig {
        allowed_hosts: vec!["pc.example.com".into(); 33],
        allow_all_hosts: false,
    };
    assert_eq!(
        config.save(dir.path()).unwrap_err(),
        "too_many_mobile_hosts"
    );
}

#[test]
fn malformed_and_unknown_configuration_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    for value in [
        json!({"typo": true}),
        json!({"allow_all_hosts": "true"}),
        json!({"allowed_hosts": ["*"]}),
        json!({"allowed_hosts": "pc.example.com"}),
    ] {
        std::fs::write(dir.path().join("mobile-listener.json"), value.to_string()).unwrap();
        assert!(HostPolicy::load(dir.path(), 8787, false).is_err());
    }
    std::fs::write(dir.path().join("mobile-listener.json"), "{").unwrap();
    assert_eq!(
        ListenerConfig::load(dir.path()).unwrap_err(),
        "invalid_mobile_listener_config"
    );
}
