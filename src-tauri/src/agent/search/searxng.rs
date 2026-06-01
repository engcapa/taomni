use super::{SearchHit, SearchOptions, SearchProvider};
use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct SearXngProvider {
    client: Client,
    /// Base URL of the SearXNG instance (e.g. "https://searx.be").
    base_url: Arc<Mutex<String>>,
}

impl SearXngProvider {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent("Taomni/0.1 (web_search; https://github.com/engcapa/taomni)")
                .build()
                .expect("failed to build reqwest client"),
            base_url: Arc::new(Mutex::new(base_url.into())),
        }
    }

    pub fn set_base_url(&self, url: impl Into<String>) {
        *self.base_url.lock().unwrap() = url.into();
    }

    pub fn base_url(&self) -> String {
        self.base_url.lock().unwrap().clone()
    }
}

#[derive(Deserialize)]
struct SearXngResponse {
    results: Vec<SearXngResult>,
}

#[derive(Deserialize)]
struct SearXngResult {
    title: String,
    url: String,
    content: Option<String>,
    #[serde(rename = "publishedDate")]
    published_date: Option<String>,
    engine: Option<String>,
}

#[async_trait]
impl SearchProvider for SearXngProvider {
    async fn search(&self, query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, String> {
        let base = self.base_url();
        let mut url = format!(
            "{}/search?q={}&format=json&language=auto",
            base,
            urlencoding::encode(query)
        );

        if let Some(freshness) = &opts.freshness {
            let time_range = match freshness.as_str() {
                "day" => "day",
                "week" => "week",
                "month" => "month",
                _ => "year",
            };
            url.push_str(&format!("&time_range={}", time_range));
        }

        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("SearXNG request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("SearXNG returned HTTP {}", resp.status()));
        }

        let data: SearXngResponse = resp
            .json()
            .await
            .map_err(|e| format!("SearXNG JSON parse failed: {}", e))?;

        let hits = data
            .results
            .into_iter()
            .take(opts.max_results as usize)
            .map(|r| SearchHit {
                title: r.title,
                url: r.url,
                snippet: r.content.unwrap_or_default(),
                source: format!("searxng:{}", r.engine.as_deref().unwrap_or("unknown")),
                published_at: r.published_date,
            })
            .collect();

        Ok(hits)
    }

    fn provider_id(&self) -> &str {
        "searxng"
    }
}
