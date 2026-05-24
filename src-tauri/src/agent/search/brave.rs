use super::{SearchHit, SearchOptions, SearchProvider};
use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

/// Brave Search API provider.
/// Free tier: $5 monthly credit (≈ 1k queries/month).
/// Docs: https://brave.com/search/api/
pub struct BraveProvider {
    client: Client,
    api_key: String,
}

impl BraveProvider {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("failed to build reqwest client"),
            api_key: api_key.into(),
        }
    }
}

#[derive(Deserialize)]
struct BraveResponse {
    web: Option<BraveWeb>,
}

#[derive(Deserialize)]
struct BraveWeb {
    results: Vec<BraveResult>,
}

#[derive(Deserialize)]
struct BraveResult {
    title: String,
    url: String,
    description: Option<String>,
    age: Option<String>,
}

#[async_trait]
impl SearchProvider for BraveProvider {
    async fn search(&self, query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, String> {
        let mut url = format!(
            "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
            urlencoding::encode(query),
            opts.max_results.min(20),
        );
        if let Some(freshness) = opts.freshness.as_deref() {
            // Brave: pd (past day), pw (past week), pm (past month), py (past year)
            let code = match freshness { "day" => "pd", "week" => "pw", "month" => "pm", _ => "py" };
            url.push_str(&format!("&freshness={}", code));
        }

        let resp = self.client
            .get(&url)
            .header("X-Subscription-Token", &self.api_key)
            .header("Accept", "application/json")
            .send().await
            .map_err(|e| format!("Brave request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Brave HTTP {}: {}", status, text));
        }

        let data: BraveResponse = resp.json().await
            .map_err(|e| format!("Brave JSON parse failed: {}", e))?;
        let results = data.web.map(|w| w.results).unwrap_or_default();

        Ok(results.into_iter().take(opts.max_results as usize).map(|r| SearchHit {
            title: r.title,
            url: r.url,
            snippet: r.description.unwrap_or_default(),
            source: "brave".into(),
            published_at: r.age,
        }).collect())
    }

    fn provider_id(&self) -> &str { "brave" }
}
