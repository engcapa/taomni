//! Tao transport resolves the same configured providers, Vault and proxy policy as Settings.
use crate::state::AppState;
use reqwest::Client;

pub struct MessagesClient {
    pub http: Client,
    pub base_url: String,
    pub api_key: String,
    pub title: bool,
    pub provider: crate::ai::config::LlmProviderConfig,
}

impl MessagesClient {
    pub async fn resolve(state: &AppState) -> Result<Self, String> {
        Self::resolve_provider(state, "deepseek-app").await
    }

    pub async fn resolve_provider(state: &AppState, provider_id: &str) -> Result<Self, String> {
        let config = state.ai_ctx.read().await.config.clone();
        let provider = provider_config(&config, provider_id)?;
        provider.validate_custom()?;
        let base_url = provider.base_url.trim_end_matches('/');
        let url =
            reqwest::Url::parse(base_url).map_err(|_| "configuration: invalid provider URL")?;
        if url.scheme() != "https" && !crate::ai::network_policy::is_local_url(base_url) {
            return Err(
                "configuration: Provider requires HTTPS (HTTP is allowed for loopback tests only)"
                    .into(),
            );
        }
        crate::ai::network_policy::reject_if_remote(config.full_local_mode, base_url)?;
        let key = provider
            .effective_api_keys()
            .into_iter()
            .find(|key| !key.trim().is_empty())
            .unwrap_or("");
        if key.is_empty() && !crate::ai::network_policy::is_local_url(base_url) {
            return Err("configuration: provider API key is missing".into());
        }
        let api_key = state
            .vault
            .resolve(key)
            .map_err(|_| "vault_locked: unlock Vault to use the provider key")?
            .map(|key| key.to_string())
            .or_else(|| (!key.starts_with(crate::vault::VAULT_REF_PREFIX)).then(|| key.to_string()))
            .ok_or("configuration: provider credential was not found")?;
        let proxy = {
            let db = state
                .db
                .lock()
                .map_err(|_| "session database unavailable")?;
            if provider.runtime == "opencode-go" {
                crate::ai::config::resolve_go_proxy_url(provider, Some(&db), Some(&state.vault))?
            } else {
                crate::ai::config::resolve_provider_proxy_url(
                    provider,
                    Some(&db),
                    Some(&state.vault),
                )?
            }
        };
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("taomni/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(600));
        if let Some(proxy) = proxy {
            builder = builder
                .proxy(reqwest::Proxy::all(proxy).map_err(|_| "configuration: invalid proxy")?);
        }
        Ok(Self {
            http: builder
                .build()
                .map_err(|_| "network: cannot create HTTP client")?,
            base_url: base_url.into(),
            api_key,
            title: config.deepseek_app.title_enabled,
            provider: provider.clone(),
        })
    }

    pub fn post(&self, endpoint: &str) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}{}", self.base_url, endpoint))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "files-api-2025-04-14")
    }
}

/// A configured LLM is eligible; harnesses and provider groups are never Tao transports.
pub fn provider_config<'a>(
    config: &'a crate::ai::config::AiConfig,
    id: &str,
) -> Result<&'a crate::ai::config::LlmProviderConfig, String> {
    if config.fully_disabled {
        return Err("disabled: AI is disabled in Settings".into());
    }
    if !config.deepseek_app.enabled {
        return Err("disabled: Tao is disabled in Settings".into());
    }
    let provider = config
        .llm
        .providers
        .get(id)
        .ok_or("configuration: provider removed; choose a configured LLM in Settings")?;
    if matches!(id, "claude-code" | "codex")
        || id.starts_with("acp:")
        || id.starts_with("group:")
        || !provider.capabilities.chat
        || !matches!(
            provider.runtime.as_str(),
            "openai-compat"
                | "openai-responses"
                | "anthropic"
                | "deepseek-messages"
                | "opencode-go"
                | "llama-server"
                | "ollama"
        )
    {
        return Err(
            "configuration: choose a chat LLM provider; harness providers are unavailable in Tao"
                .into(),
        );
    }
    crate::ai::network_policy::reject_if_remote(config.full_local_mode, &provider.base_url)?;
    Ok(provider)
}

pub fn validate_request(
    provider: &crate::ai::config::LlmProviderConfig,
    request: &super::types::TaoRequest,
) -> Result<(), String> {
    if let Some(model) = provider.custom_model(&request.model)? {
        if request.thinking && !model.reasoning_efforts.contains(&request.reasoning_effort) {
            return Err("configuration: choose a reasoning effort supported by this model".into());
        }
        if request.web && !model.native_search {
            return Err("configuration: this model does not support native search".into());
        }
        return Ok(());
    }
    if provider.runtime == "deepseek-messages"
        && !matches!(request.model.as_str(), "deepseek-flash" | "deepseek-v4-pro")
    {
        return Err("protocol: unsupported DeepSeek Messages model".into());
    }
    if !matches!(
        provider.runtime.as_str(),
        "deepseek-messages" | "opencode-go"
    ) && (request.thinking || request.web)
    {
        return Err(
            "configuration: this provider uses standard chat; disable Tao thinking and web".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_configured_llms_are_available_but_harnesses_and_disabled_chat_are_rejected() {
        let mut config = crate::ai::config::AiConfig::default();
        let mut provider = config.llm.providers["deepseek"].clone();
        provider.model = "configured-v2".into();
        for runtime in [
            "openai-compat",
            "anthropic",
            "ollama",
            "llama-server",
            "deepseek-messages",
            "opencode-go",
        ] {
            provider.runtime = runtime.into();
            config
                .llm
                .providers
                .insert("custom".into(), provider.clone());
            assert_eq!(
                provider_config(&config, "custom").unwrap().model,
                "configured-v2"
            );
        }
        for id in ["claude-code", "codex", "acp:profile", "group:rotation"] {
            config.llm.providers.insert(id.into(), provider.clone());
            assert!(provider_config(&config, id).is_err());
        }
        config
            .llm
            .providers
            .get_mut("custom")
            .unwrap()
            .capabilities
            .chat = false;
        assert!(provider_config(&config, "custom").is_err());
        config.fully_disabled = true;
        assert!(provider_config(&config, "deepseek").is_err());
    }

    #[test]
    fn ordinary_requests_preserve_models_and_cannot_silently_ignore_tao_only_switches() {
        let mut config = crate::ai::config::AiConfig::default();
        let provider = config.llm.providers["deepseek"].clone();
        let mut request: super::super::types::TaoRequest = serde_json::from_value(serde_json::json!({
            "threadId":"t", "content":"Hello", "provider":"deepseek", "model":"configured-v2", "mode":"do"
        })).unwrap();
        assert!(validate_request(&provider, &request).is_ok());
        request.thinking = true;
        assert!(validate_request(&provider, &request).is_err());
        request.thinking = false;
        request.web = true;
        assert!(validate_request(&provider, &request).is_err());
        config.full_local_mode = true;
        assert!(provider_config(&config, "deepseek").is_err());
        config.llm.providers.get_mut("deepseek").unwrap().base_url =
            "http://127.0.0.1:9000/v1".into();
        assert!(provider_config(&config, "deepseek").is_ok());
    }
}
