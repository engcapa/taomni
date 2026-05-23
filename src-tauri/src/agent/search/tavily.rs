use super::{SearchHit, SearchOptions, SearchProvider};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub struct TavilyProvider {
    client: Client,
    api_key: String,
}

impl TavilyProvider {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("failed to build reqwest client"),
            api_key: api_key.into(),
        }
    }
}

#[derive(Serialize)]
struct TavilyRequest<'a> {
    api_key: &'a str,
    query: &'a str,
    max_results: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    days: Option<u32>,
}

#[derive(Deserialize)]
struct TavilyResponse {
    results: Vec<TavilyResult>,
}

#[derive(Deserialize)]
struct TavilyResult {
    title: String,
    url: String,
    content: String,
    published_date: Option<String>,
}

#[async_trait]
impl SearchProvider for TavilyProvider {
    async fn search(&self, query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, String> {
        let days = opts.freshness.as_deref().map(|f| match f {
            "day" => 1, "week" => 7, "month" => 30, _ => 365,
        });

        let body = TavilyRequest {
            api_key: &self.api_key,
            query,
            max_results: opts.max_results.min(10),
            days,
        };

        let resp = self.client
            .post("https://api.tavily.com/search")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Tavily request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Tavily HTTP {}: {}", status, text));
        }

        let data: TavilyResponse = resp.json().await
            .map_err(|e| format!("Tavily JSON parse failed: {}", e))?;

        Ok(data.results.into_iter().map(|r| SearchHit {
            title: r.title,
            url: r.url,
            snippet: r.content,
            source: "tavily".into(),
            published_at: r.published_date,
        }).collect())
    }

    fn provider_id(&self) -> &str {
        "tavily"
    }
}
