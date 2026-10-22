use super::llm::LlmProviderConfig;
use super::llm::default_opencode_go_provider;
use super::persistence::AiConfig;
use super::proxy::resolve_go_proxy_url;
use super::proxy::resolve_go_proxy_with_app;

#[test]
fn go_proxy_defaults_and_round_trip_preserve_explicit_modes() {
    let mut value = serde_json::to_value(super::llm::default_opencode_go_provider()).unwrap();
    value.as_object_mut().unwrap().remove("proxy_mode");
    let mut go: super::llm::LlmProviderConfig = serde_json::from_value(value.clone()).unwrap();
    go.normalize();
    assert_eq!(go.proxy_mode, "app");
    value["runtime"] = "openai-compat".into();
    let mut legacy: super::llm::LlmProviderConfig = serde_json::from_value(value).unwrap();
    legacy.normalize();
    assert_eq!(legacy.proxy_mode, "app");
    go.custom_proxy = Some(crate::proxy::AppProxyConfig {
        host: "independent".into(),
        ..Default::default()
    });
    go.proxy_url = Some("http://legacy:3128".into());
    for mode in ["app", "custom", "none", "manual", "session"] {
        go.proxy_mode = mode.into();
        let mut restored: super::llm::LlmProviderConfig =
            serde_json::from_value(serde_json::to_value(&go).unwrap()).unwrap();
        restored.normalize();
        assert_eq!(restored.proxy_mode, mode);
        assert_eq!(restored.custom_proxy, go.custom_proxy);
    }
    legacy.proxy_url = go.proxy_url;
    legacy.proxy_mode.clear();
    legacy.normalize();
    assert_eq!(legacy.proxy_mode, "manual");
}

#[test]
fn go_proxy_uses_application_or_independent_settings_and_never_falls_back() {
    let app = crate::proxy::AppProxyConfig {
        enabled: true,
        host: "app-proxy".into(),
        ..Default::default()
    };
    let mut go = super::llm::default_opencode_go_provider();
    assert_eq!(
        super::proxy::resolve_go_proxy_with_app(&go, None, None, || Ok(app.clone()))
            .unwrap()
            .as_deref(),
        Some("http://app-proxy:3128")
    );
    assert!(
        super::proxy::resolve_go_proxy_with_app(&go, None, None, || Err(
            "invalid app config".into()
        ))
        .is_err()
    );
    assert_eq!(
        super::proxy::resolve_go_proxy_with_app(&go, None, None, || Ok(Default::default()))
            .unwrap(),
        None
    );
    go.proxy_mode = "custom".into();
    assert!(super::proxy::resolve_go_proxy_url(&go, None, None).is_err());
    go.custom_proxy = Some(crate::proxy::AppProxyConfig {
        host: "custom-proxy".into(),
        ..Default::default()
    });
    assert_eq!(
        super::proxy::resolve_go_proxy_with_app(&go, None, None, || panic!(
            "custom must not load application proxy"
        ))
        .unwrap()
        .as_deref(),
        Some("http://custom-proxy:3128")
    );
    assert_eq!(app.host, "app-proxy");
    go.custom_proxy.as_mut().unwrap().password_ref = "vault:missing".into();
    assert!(super::proxy::resolve_go_proxy_url(&go, None, None).is_err());
    go.proxy_mode = "none".into();
    go.proxy_url = Some("http://retained:3128".into());
    go.normalize();
    assert_eq!(
        super::proxy::resolve_go_proxy_with_app(&go, None, None, || panic!(
            "none must bypass application proxy"
        ))
        .unwrap(),
        None
    );
    go.proxy_mode = "session".into();
    assert!(super::proxy::resolve_go_proxy_url(&go, None, None).is_err());
    go.proxy_mode = "manual".into();
    assert_eq!(
        super::proxy::resolve_go_proxy_url(&go, None, None)
            .unwrap()
            .as_deref(),
        Some("http://retained:3128")
    );
    go.proxy_url = None;
    assert!(super::proxy::resolve_go_proxy_url(&go, None, None).is_err());
}

#[test]
fn legacy_go_normalization_preserves_user_configuration() {
    let mut config = super::persistence::AiConfig::default();
    config.llm.providers.remove("opencode-go");
    let routes = config.llm.task_routing.clone();
    let original = serde_json::to_value(&config.llm.providers["deepseek"]).unwrap();
    config.llm.normalize();
    let go = &config.llm.providers["opencode-go"];
    assert_eq!(go.model, "deepseek-v4.1-flash");
    assert_eq!(go.runtime, "opencode-go");
    assert_eq!(config.llm.task_routing, routes);
    assert_eq!(
        serde_json::to_value(&config.llm.providers["deepseek"]).unwrap(),
        original
    );
    assert!(
        serde_json::to_value(go)
            .unwrap()
            .get("protocol_overrides")
            .is_none()
    );
    let parsed: super::llm::LlmProviderConfig = serde_json::from_value(original).unwrap();
    assert!(parsed.protocol_overrides.is_empty());
    config.llm.providers.get_mut("opencode-go").unwrap().model = "custom".into();
    config.llm.normalize();
    assert_eq!(config.llm.providers["opencode-go"].model, "custom");
}

#[test]
fn legacy_ai_config_without_acp_section_gets_disabled_grok_preset() {
    let current = AiConfig::default();
    let mut value = serde_json::to_value(&current).unwrap();
    value.as_object_mut().unwrap().remove("acp_bridge");

    let mut loaded: AiConfig = serde_json::from_value(value).unwrap();
    loaded.normalize();

    assert!(!loaded.acp_bridge.enabled);
    assert_eq!(loaded.acp_bridge.profiles.len(), 1);
    assert_eq!(loaded.acp_bridge.profiles[0].id, "grok");
    assert!(!loaded.acp_bridge.profiles[0].enabled);
    assert!(!loaded.llm.providers.contains_key("grok"));
    assert!(!loaded.llm.providers.contains_key("xai"));
    assert_eq!(
        serde_json::to_value(&loaded.cc_bridge).unwrap(),
        serde_json::to_value(&current.cc_bridge).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&loaded.codex_bridge).unwrap(),
        serde_json::to_value(&current.codex_bridge).unwrap()
    );
}
