use super::{SearchHit, SearchOptions, SearchProvider};
use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

/// Google Programmable Search Engine (Custom Search JSON API).
/// Free tier: 100 queries/day; $5 / 1000 thereafter.
/// Requires both an API key (from Google Cloud) and a CSE id (cx).
/// Docs: https://developers.google.com/custom-search/v1/overview
///
/// Two-segment "key": we accept the user's BYOK as `<api_key>:<cx>` to keep
/// the existing single-key UX. Anything missing the colon is rejected so
/// the user sees a clear error instead of a silent empty result.
pub struct GoogleCseProvider {
    client: Client,
    api_key: String,
    cx: String,
}

impl GoogleCseProvider {
    pub fn new(combined: impl Into<String>) -> Result<Self, String> {
        let raw = combined.into();
        let (api_key, cx) = raw.split_once(':')
            .ok_or_else(|| "Google CSE key must be 'API_KEY:CX' (colon-separated)".to_string())?;
        if api_key.is_empty() || cx.is_empty() {
            return Err("Google CSE key/cx cannot be empty".into());
        }
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())?,
            api_key: api_key.into(),
            cx: cx.into(),
        })
    }
}

#[derive(Deserialize)]
struct CseResponse {
    items: Option<Vec<CseItem>>,
}

#[derive(Deserialize)]
struct CseItem {
    title: String,
    link: String,
    snippet: Option<String>,
    #[serde(rename = "pagemap")]
    pagemap: Option<serde_json::Value>,
}

#[async_trait]
impl SearchProvider for GoogleCseProvider {
    async fn search(&self, query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, String> {
        let mut url = format!(
            "https://www.googleapis.com/customsearch/v1?key={}&cx={}&q={}&num={}",
            urlencoding::encode(&self.api_key),
            urlencoding::encode(&self.cx),
            urlencoding::encode(query),
            opts.max_results.min(10),
        );
        if let Some(freshness) = opts.freshness.as_deref() {
            // Google: dateRestrict d1 / w1 / m1 / y1
            let code = match freshness { "day" => "d1", "week" => "w1", "month" => "m1", _ => "y1" };
            url.push_str(&format!("&dateRestrict={}", code));
        }

        let resp = self.client.get(&url).send().await
            .map_err(|e| format!("Google CSE request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Google CSE HTTP {}: {}", status, text));
        }

        let data: CseResponse = resp.json().await
            .map_err(|e| format!("Google CSE JSON parse failed: {}", e))?;

        let items = data.items.unwrap_or_default();
        Ok(items.into_iter().map(|i| {
            let published = i.pagemap.as_ref()
                .and_then(|pm| pm.get("metatags"))
                .and_then(|m| m.as_array())
                .and_then(|arr| arr.first())
                .and_then(|first| first.get("article:published_time"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            SearchHit {
                title: i.title,
                url: i.link,
                snippet: i.snippet.unwrap_or_default(),
                source: "google_cse".into(),
                published_at: published,
            }
        }).collect())
    }

    fn provider_id(&self) -> &str { "google_cse" }
}
