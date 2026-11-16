//! Dedicated Messages transport: no changes to the legacy Llm trait/providers.
use crate::state::AppState;
use reqwest::Client;

pub struct MessagesClient {
    pub http: Client,
    pub base_url: String,
    pub api_key: String,
    pub title: bool,
}

impl MessagesClient {
    pub async fn resolve(state: &AppState) -> Result<Self, String> {
        Self::resolve_provider(state, "deepseek-app").await
    }

    pub async fn resolve_provider(state: &AppState, provider_id: &str) -> Result<Self, String> {
        if !matches!(provider_id, "deepseek-app" | "opencode-go") {
            return Err("configuration: unsupported Tao provider".into());
        }
        let config = state.legacy.ai_ctx.read().await.config.clone();
        if config.fully_disabled {
            return Err("disabled: AI is disabled in Settings".into());
        }
        if !config.deepseek_app.enabled {
            return Err("disabled: Tao is disabled in Settings".into());
        }
        let provider = config
            .llm
            .providers
            .get(provider_id)
            .ok_or("configuration: configure the Tao provider in Settings")?;
        let base_url = provider.base_url.trim_end_matches('/');
        let url =
            reqwest::Url::parse(base_url).map_err(|_| "configuration: invalid DeepSeek URL")?;
        if url.scheme() != "https" && !crate::ai::network_policy::is_local_url(base_url) {
            return Err(
                "configuration: DeepSeek requires HTTPS (HTTP is allowed for loopback tests only)"
                    .into(),
            );
        }
        crate::ai::network_policy::reject_if_remote(config.full_local_mode, base_url)?;
        let key = provider
            .effective_api_keys()
            .into_iter()
            .find(|key| !key.trim().is_empty())
            .ok_or("configuration: DeepSeek API key is missing")?;
        let api_key = state
            .core
            .vault
            .resolve(key)
            .map_err(|_| "vault_locked: unlock Vault to use the DeepSeek key")?
            .map(|key| key.to_string())
            .unwrap_or_else(|| key.to_string());
        let proxy = {
            let db = state
                .core
                .db
                .lock()
                .map_err(|_| "session database unavailable")?;
            if provider_id == "opencode-go" {
                crate::ai::config::resolve_go_proxy_url(
                    provider,
                    Some(&db),
                    Some(&state.core.vault),
                )?
            } else {
                crate::ai::config::resolve_provider_proxy_url(
                    provider,
                    Some(&db),
                    Some(&state.core.vault),
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
