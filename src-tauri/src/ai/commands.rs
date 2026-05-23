use crate::ai::config::{AiConfig, LlmProviderConfig, default_ai_config_path};
use crate::llm::openai_compat::OpenAiCompatProvider;
use crate::llm::{ChatRequest, Llm};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u64,
}

/// Get the current AI configuration.
#[tauri::command]
pub async fn get_ai_config() -> Result<AiConfig, String> {
    let path = default_ai_config_path();
    Ok(AiConfig::load(&path))
}

/// Save the AI configuration.
#[tauri::command]
pub async fn save_ai_config(config: AiConfig) -> Result<(), String> {
    let path = default_ai_config_path();
    config.save(&path).map_err(|e| e.to_string())
}

/// Test connectivity to a specific LLM provider.
#[tauri::command]
pub async fn test_llm_connection(provider: LlmProviderConfig) -> Result<TestConnectionResult, String> {
    let llm: Arc<dyn Llm> = Arc::new(OpenAiCompatProvider::new(
        "test",
        &provider.base_url,
        &provider.api_key,
        &provider.model,
    ));

    let start = std::time::Instant::now();
    let req = ChatRequest::simple("You are a test assistant.", "Reply with exactly: pong");

    match llm.chat(req).await {
        Ok(resp) => Ok(TestConnectionResult {
            ok: true,
            message: resp.content,
            latency_ms: start.elapsed().as_millis() as u64,
        }),
        Err(e) => Ok(TestConnectionResult {
            ok: false,
            message: e.to_string(),
            latency_ms: start.elapsed().as_millis() as u64,
        }),
    }
}
