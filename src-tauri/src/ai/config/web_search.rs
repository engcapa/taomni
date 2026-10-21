use serde::Deserialize;
use serde::Serialize;

// ── Web Search ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchConfig {
    /// "searxng" | "tavily" | "serper"
    pub client_provider: String,
    /// Whether client-side web search is enabled (default: false).
    pub client_enabled: bool,
    /// Confirmation mode: "per_call" | "per_thread" | "always" | "disabled"
    pub confirm_mode: String,
    /// BYOK API key for Tavily/Serper (stored here for simplicity; production would use OS keyring).
    #[serde(default)]
    pub byok_key: String,
    /// Custom SearXNG instance URL (overrides public instance probe).
    pub searxng_url: Option<String>,
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            client_provider: "searxng".into(),
            client_enabled: false,
            confirm_mode: "per_call".into(),
            byok_key: String::new(),
            searxng_url: None,
        }
    }
}
