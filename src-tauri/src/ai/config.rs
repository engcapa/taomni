mod persistence;

mod asr;

mod llm;

mod proxy;

mod web_search;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod asr_migration_tests;

pub use persistence::{AiConfig, default_ai_config_path};

pub use asr::{AsrConfig, AsrProviderConfig};

pub use llm::{
    FallbackConfig, LlmConfig, LlmProviderCapabilities, LlmProviderConfig, LlmProviderGroupConfig,
    default_opencode_go_provider,
};

pub use proxy::{
    normalize_go_proxy_mode, normalize_provider_proxy_mode, resolve_go_proxy_url,
    resolve_provider_proxy_url,
};

pub use web_search::WebSearchConfig;
