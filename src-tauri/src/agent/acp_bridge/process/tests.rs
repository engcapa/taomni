use super::diagnostics::append_bounded;
use super::diagnostics::sanitize_diagnostic;
use super::model::AcpProcessConfig;

#[test]
fn process_config_debug_omits_environment_values() {
    let config =
        AcpProcessConfig::new("agent", vec!["stdio".into()]).with_env("API_KEY", "must-not-appear");
    let debug = format!("{config:?}");
    assert!(debug.contains("API_KEY"));
    assert!(!debug.contains("must-not-appear"));
}

#[test]
fn diagnostic_buffer_is_bounded_and_utf8_safe() {
    let mut buffer = String::new();
    append_bounded(&mut buffer, "123456é", 5);
    assert!(buffer.is_char_boundary(0));
    assert!(buffer.len() <= 5);
    assert!(buffer.ends_with('é'));
}

#[test]
fn diagnostics_redact_json_secrets_and_proxy_credentials() {
    let value = sanitize_diagnostic(
        r#"{"api_key":"super-secret","proxy":"http://user:pass@example.test"}"#,
    );
    assert!(!value.contains("super-secret"));
    assert!(!value.contains("user:pass"));
    assert!(value.contains("[REDACTED]"));
}
