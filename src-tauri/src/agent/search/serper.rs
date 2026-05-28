use super::{SearchHit, SearchOptions, SearchProvider};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub struct SerperProvider {
    client: Client,
    api_key: String,
}

impl SerperProvider {
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

#[derive(Serialize)]
struct SerperRequest<'a> {
    q: &'a str,
    num: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tbs: Option<String>,
}

#[derive(Deserialize)]
struct SerperResponse {
    organic: Vec<SerperResult>,
}

#[derive(Deserialize)]
struct SerperResult {
    title: String,
    link: String,
    snippet: Option<String>,
    date: Option<String>,
}

#[async_trait]
impl SearchProvider for SerperProvider {
    async fn search(&self, query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, String> {
        let tbs = opts.freshness.as_deref().map(|f| match f {
            "day" => "qdr:d".to_string(),
            "week" => "qdr:w".to_string(),
            "month" => "qdr:m".to_string(),
            _ => "qdr:y".to_string(),
        });

        let body = SerperRequest {
            q: query,
            num: opts.max_results.min(10),
            tbs,
        };

        let resp = self
            .client
            .post("https://google.serper.dev/search")
            .header("X-API-KEY", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Serper request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Serper HTTP {}", resp.status()));
        }

        let data: SerperResponse = resp
            .json()
            .await
            .map_err(|e| format!("Serper JSON parse failed: {}", e))?;

        Ok(data
            .organic
            .into_iter()
            .map(|r| SearchHit {
                title: r.title,
                url: r.link,
                snippet: r.snippet.unwrap_or_default(),
                source: "serper".into(),
                published_at: r.date,
            })
            .collect())
    }

    fn provider_id(&self) -> &str {
        "serper"
    }
}
