pub mod commands;
pub mod instances;
pub mod key_storage;
pub mod searxng;
pub mod serper;
pub mod tavily;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    /// Filter by recency: "day" | "week" | "month"
    pub freshness: Option<String>,
    pub max_results: u32,
}

impl SearchOptions {
    pub fn new(max_results: u32) -> Self {
        Self { max_results, freshness: None }
    }
}

#[async_trait]
pub trait SearchProvider: Send + Sync {
    async fn search(&self, query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, String>;
    fn provider_id(&self) -> &str;
}
