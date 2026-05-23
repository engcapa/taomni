use crate::agent::search::searxng::SearXngProvider;
use crate::agent::search::serper::SerperProvider;
use crate::agent::search::tavily::TavilyProvider;
use crate::agent::search::{SearchHit, SearchOptions, SearchProvider};
use crate::agent::tools::web_fetch::WebFetchTool;
use crate::agent::tools::Tool;
use crate::ai::config::{AiConfig, default_ai_config_path};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use crate::state::AppState;

fn build_search_provider(config: &AiConfig) -> Arc<dyn SearchProvider> {
    let ws = &config.web_search;
    match ws.client_provider.as_str() {
        "tavily" if !ws.byok_key.is_empty() => Arc::new(TavilyProvider::new(&ws.byok_key)),
        "serper" if !ws.byok_key.is_empty() => Arc::new(SerperProvider::new(&ws.byok_key)),
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
