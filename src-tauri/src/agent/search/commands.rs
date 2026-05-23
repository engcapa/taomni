use crate::agent::search::searxng::SearXngProvider;
use crate::agent::search::serper::SerperProvider;
use crate::agent::search::tavily::TavilyProvider;
use crate::agent::search::{key_storage, SearchHit, SearchOptions, SearchProvider};
use crate::agent::tools::web_fetch::WebFetchTool;
use crate::agent::tools::Tool;
use crate::ai::config::{AiConfig, default_ai_config_path};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use crate::state::AppState;

fn build_search_provider(config: &AiConfig) -> Arc<dyn SearchProvider> {
    let ws = &config.web_search;
    // Prefer the OS keyring; fall back to the legacy ai.json byok_key field
    // for users who haven't migrated yet.
    let key_from_keyring = key_storage::get("ai_api_key", &ws.client_provider)
        .ok()
        .flatten();
    let api_key = key_from_keyring.unwrap_or_else(|| ws.byok_key.clone());

    match ws.client_provider.as_str() {
        "tavily" if !api_key.is_empty() => Arc::new(TavilyProvider::new(&api_key)),
        "serper" if !api_key.is_empty() => Arc::new(SerperProvider::new(&api_key)),
        _ => Arc::new(SearXngProvider::new(
            ws.searxng_url.as_deref()
                .unwrap_or(crate::agent::search::instances::PUBLIC_INSTANCES[0])
        )),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WebSearchResult {
    pub hits: Vec<SearchHit>,
    pub provider: String,
    pub query: String,
}

/// Execute a web search (called after user confirms the WebSearchConfirmCard).
#[tauri::command]
pub async fn web_search_execute(
    query: String,
    freshness: Option<String>,
    max_results: Option<u32>,
) -> Result<WebSearchResult, String> {
    let config = AiConfig::load(&default_ai_config_path());
    if config.fully_disabled {
        return Err("AI is fully disabled.".into());
    }
    if config.full_local_mode {
        return Err("FULL_LOCAL_MODE: web search is blocked when full-local mode is on.".into());
    }
    if !config.web_search.client_enabled {
        return Err("Web search is disabled. Enable it in Settings → AI → Web Search.".into());
    }

    let provider = build_search_provider(&config);
    let provider_id = provider.provider_id().to_string();
    let opts = SearchOptions {
        freshness,
        max_results: max_results.unwrap_or(5).min(10),
    };

    let hits = provider.search(&query, &opts).await?;
    Ok(WebSearchResult { hits, provider: provider_id, query })
}

/// Fetch a URL's readable content (called after user confirms).
#[tauri::command]
pub async fn web_fetch_execute(url: String) -> Result<String, String> {
    let config = AiConfig::load(&default_ai_config_path());
    if config.fully_disabled {
        return Err("AI is fully disabled.".into());
    }
    crate::ai::network_policy::reject_if_remote(config.full_local_mode, &url)?;

    let tool = WebFetchTool::new();
    let args = serde_json::json!({ "url": url });
    let result = tool.execute(&args).await;
    if result.ok {
        Ok(result.output)
    } else {
        Err(result.output)
    }
}

/// Probe SearXNG public instances and return the fastest one.
#[tauri::command]
pub async fn probe_searxng_instances() -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(crate::agent::search::instances::probe_best_instance(&client).await)
}

/// Returns the capabilities of the currently active LLM provider.
/// The frontend uses this to decide whether to surface
/// `web_search` (when the provider lacks native) or `deep_search`
/// (when it has native and the user asks for a manual extra search).
#[tauri::command]
pub async fn provider_caps(
    state: State<'_, AppState>,
) -> Result<crate::llm::openai_compat::ProviderCaps, String> {
    let ai_ctx = state.ai_ctx.read().await;
    Ok(crate::llm::openai_compat::ProviderCaps::for_provider(
        &ai_ctx.config.llm.active,
    ))
}
