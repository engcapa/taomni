use super::{ChatRequest, ChatResponse, Llm, LlmError, LlmResult, TaskKind};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;

/// Routes a chat request to the appropriate provider based on task kind,
/// with optional timeout + fallback to a secondary provider.
pub struct LlmRouter {
    providers: HashMap<String, Arc<dyn Llm>>,
    task_routing: HashMap<TaskKind, String>,
    active: String,
    fallback: Option<FallbackConfig>,
}

pub struct FallbackConfig {
    pub primary: String,
    pub secondary: String,
    pub timeout_ms: u64,
}

impl LlmRouter {
    pub fn new(active: impl Into<String>) -> Self {
        Self {
            providers: HashMap::new(),
            task_routing: HashMap::new(),
            active: active.into(),
            fallback: None,
        }
    }

    pub fn add_provider(&mut self, id: impl Into<String>, provider: Arc<dyn Llm>) {
        self.providers.insert(id.into(), provider);
    }

    pub fn set_task_route(&mut self, task: TaskKind, provider_id: impl Into<String>) {
        self.task_routing.insert(task, provider_id.into());
    }

    pub fn set_fallback(&mut self, config: FallbackConfig) {
        self.fallback = Some(config);
    }

    pub async fn complete(&self, req: ChatRequest, task: TaskKind) -> LlmResult<ChatResponse> {
        let primary_id = self.task_routing
            .get(&task)
            .unwrap_or(&self.active)
            .clone();

        let primary = self.providers.get(&primary_id)
            .ok_or_else(|| LlmError::NoProvider(task))?;

        // If fallback is configured and primary matches the fallback primary, apply timeout.
        if let Some(fb) = &self.fallback {
            if primary_id == fb.primary {
                let result = timeout(
                    Duration::from_millis(fb.timeout_ms),
                    primary.chat(req.clone()),
                ).await;

                match result {
                    Ok(Ok(resp)) => return Ok(resp),
                    Ok(Err(e)) => {
                        tracing::warn!(provider = %primary_id, error = %e, "primary LLM failed, falling back");
                    }
                    Err(_) => {
                        tracing::warn!(provider = %primary_id, timeout_ms = fb.timeout_ms, "primary LLM timed out, falling back");
                    }
                }

                let secondary = self.providers.get(&fb.secondary)
                    .ok_or_else(|| LlmError::NoProvider(task))?;
                return secondary.chat(req).await;
            }
        }

        primary.chat(req).await
    }

    /// Test connectivity to a provider by sending a minimal ping request.
    pub async fn test_connection(&self, provider_id: &str) -> LlmResult<String> {
        let provider = self.providers.get(provider_id)
            .ok_or_else(|| LlmError::NoProvider(TaskKind::ChatDrawer))?;

        let req = ChatRequest::simple("You are a test assistant.", "Reply with exactly: pong");
        let resp = timeout(Duration::from_secs(10), provider.chat(req))
            .await
            .map_err(|_| LlmError::Timeout { ms: 10_000 })??;

        Ok(resp.content)
    }
}
