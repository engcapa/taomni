use super::llm::LlmProviderConfig;

pub(super) fn default_provider_proxy_mode() -> String {
    "app".into()
}

pub fn normalize_provider_proxy_mode(mode: &str) -> String {
    match mode.trim() {
        "session" | "manual" => mode.trim().into(),
        _ => "none".into(),
    }
}

pub fn resolve_provider_proxy_url(
    provider: &LlmProviderConfig,
    db: Option<&rusqlite::Connection>,
    vault: Option<&crate::vault::Vault>,
) -> Result<Option<String>, String> {
    resolve_go_proxy_url(provider, db, vault)
        .map_err(|error| error.replace("OpenCode Go", "LLM provider"))
}

pub fn normalize_go_proxy_mode(mode: &str) -> String {
    match mode.trim() {
        "custom" | "none" | "session" | "manual" => mode.trim().into(),
        _ => "app".into(),
    }
}

/// Go uses the shared Settings proxy format, with strict failure handling.
pub fn resolve_go_proxy_url(
    provider: &LlmProviderConfig,
    db: Option<&rusqlite::Connection>,
    vault: Option<&crate::vault::Vault>,
) -> Result<Option<String>, String> {
    resolve_go_proxy_with_app(provider, db, vault, || {
        crate::proxy::AppProxyConfig::load_strict(&crate::proxy::default_app_proxy_path())
    })
}

pub(super) fn resolve_go_proxy_with_app(
    provider: &LlmProviderConfig,
    db: Option<&rusqlite::Connection>,
    vault: Option<&crate::vault::Vault>,
    load_app: impl FnOnce() -> Result<crate::proxy::AppProxyConfig, String>,
) -> Result<Option<String>, String> {
    let mode = normalize_go_proxy_mode(&provider.proxy_mode);
    let config = match mode.as_str() {
        "none" => return Ok(None),
        "app" => load_app()?,
        "custom" => {
            let mut config = provider
                .custom_proxy
                .clone()
                .ok_or("OpenCode Go custom proxy is not configured")?;
            config.enabled = true;
            config
        }
        "session" => crate::proxy::AppProxyConfig {
            enabled: true,
            mode: "session".into(),
            session_id: provider.proxy_session_id.clone().unwrap_or_default(),
            ..Default::default()
        },
        "manual" => {
            let url = provider
                .proxy_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("OpenCode Go manual proxy URL is required")?;
            reqwest::Proxy::all(url).map_err(|_| "OpenCode Go proxy URL is invalid")?;
            return Ok(Some(url.into()));
        }
        _ => unreachable!(),
    };
    crate::proxy::resolve_strict_with_db(&config, db, vault).map(|proxy| proxy.map(|p| p.to_url()))
}
