use super::{ApprovalBroker, SecurityMode, SocketAddr, experimental_feature_value};

#[test]
fn production_security_accepts_only_hybrid() {
    assert_eq!(SecurityMode::parse("hybrid"), Ok(SecurityMode::Hybrid));
    assert_eq!(SecurityMode::parse("NLA"), Ok(SecurityMode::Hybrid));
    assert!(SecurityMode::parse("tls").is_err());
    assert!(SecurityMode::parse("none").is_err());
}

#[test]
fn socket_address_detects_public_wildcards() {
    let ipv4: SocketAddr = "0.0.0.0:3389".parse().unwrap();
    let ipv6: SocketAddr = "[::]:3389".parse().unwrap();
    assert!(ipv4.ip().is_unspecified());
    assert!(ipv6.ip().is_unspecified());
}

#[test]
fn approval_broker_resolves_each_request_once() {
    let broker = ApprovalBroker::default();
    let receiver = broker.register("request-1".to_string());
    assert!(broker.resolve("request-1", true));
    assert_eq!(receiver.recv().unwrap(), true);
    assert!(!broker.resolve("request-1", false));
    assert!(!broker.resolve("missing", true));
}

#[test]
fn experimental_rdp_features_require_an_explicit_truthy_value() {
    for enabled in ["1", "true", "TRUE", " yes ", "on"] {
        assert!(
            experimental_feature_value(enabled),
            "{enabled} should opt in"
        );
    }
    for disabled in ["", "0", "false", "no", "off", "unexpected"] {
        assert!(
            !experimental_feature_value(disabled),
            "{disabled} should keep compatibility mode"
        );
    }
}
