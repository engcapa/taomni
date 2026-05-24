use super::{SearchHit, SearchOptions, SearchProvider};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Exa Search API (formerly Metaphor) — neural index, good for academic /
/// long-tail English content. Docs: https://docs.exa.ai/
pub struct ExaProvider {
    client: Client,
    api_key: String,
}

impl ExaProvider {
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
struct ExaRequest<'a> {
    query: &'a str,
    #[serde(rename = "numResults")]
    num_results: u32,
    #[serde(rename = "useAutoprompt")]
    use_autoprompt: bool,
    #[serde(rename = "startPublishedDate", skip_serializing_if = "Option::is_none")]
    start_published_date: Option<String>,
}

#[derive(Deserialize)]
struct ExaResponse {
    results: Vec<ExaResult>,
}

#[derive(Deserialize)]
struct ExaResult {
    title: Option<String>,
    url: String,
    text: Option<String>,
    #[serde(rename = "publishedDate")]
    published_date: Option<String>,
}

#[async_trait]
impl SearchProvider for ExaProvider {
    async fn search(&self, query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, String> {
        let start_published = opts.freshness.as_deref().map(|f| {
            let now = chrono::Utc::now();
            let days = match f { "day" => 1, "week" => 7, "month" => 30, _ => 365 };
            (now - chrono::Duration::days(days)).format("%Y-%m-%dT%H:%M:%S.000Z").to_string()
        });

        let body = ExaRequest {
            query,
            num_results: opts.max_results.min(10),
            use_autoprompt: true,
            start_published_date: start_published,
        };

        let resp = self.client
            .post("https://api.exa.ai/search")
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send().await
            .map_err(|e| format!("Exa request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Exa HTTP {}: {}", status, text));
        }

        let data: ExaResponse = resp.json().await
            .map_err(|e| format!("Exa JSON parse failed: {}", e))?;
        Ok(data.results.into_iter().map(|r| SearchHit {
            title: r.title.unwrap_or_else(|| r.url.clone()),
            url: r.url,
            snippet: r.text.unwrap_or_default(),
            source: "exa".into(),
            published_at: r.published_date,
        }).collect())
    }

    fn provider_id(&self) -> &str { "exa" }
}
