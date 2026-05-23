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

    /// True if a provider with this id is registered.
    pub fn has_provider(&self, id: &str) -> bool {
        self.providers.contains_key(id)
    }

    /// Returns the active default provider id.
    pub fn active(&self) -> &str {
        &self.active
    }

    /// Returns the provider id that this task would actually route to.
    pub fn provider_for_task(&self, task: TaskKind) -> String {
        self.task_routing
            .get(&task)
            .cloned()
            .unwrap_or_else(|| self.active.clone())
    }

    /// Get a direct reference to a provider by id (used by chat streaming etc).
    pub fn provider(&self, id: &str) -> Option<Arc<dyn Llm>> {
        self.providers.get(id).cloned()
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

// ── Build helpers ─────────────────────────────────────────────────────────────

use crate::ai::config::{AiConfig, LlmConfig};
use super::openai_compat::OpenAiCompatProvider;

fn task_kind_from_str(s: &str) -> Option<TaskKind> {
    Some(match s {
        "voice_intent"    => TaskKind::VoiceIntent,
        "voice_to_shell"  => TaskKind::VoiceToShell,
        "tab_completion"  => TaskKind::TabCompletion,
        "command_rewrite" => TaskKind::CommandRewrite,
        "chat_drawer"     => TaskKind::ChatDrawer,
        "inline_qq"       => TaskKind::InlineQq,
        "agent_default"   => TaskKind::AgentDefault,
        "web_search"      => TaskKind::WebSearch,
        "code_mode"       => TaskKind::CodeMode,
        _ => return None,
    })
}

/// Resolve a possibly `vault:<id>`-prefixed value to plaintext.
/// Returns the original value unchanged when no vault is provided or the
/// value is already plaintext.
fn resolve_api_key(value: &str, vault: Option<&crate::vault::Vault>) -> String {
    if let Some(v) = vault {
        match v.resolve(value) {
            Ok(Some(plaintext)) => return plaintext.to_string(),
            Ok(None) => {}                // not a vault ref, treat as plaintext
            Err(_) => {}                  // locked / missing — return value as-is and let caller see the auth error
        }
    }
    value.to_string()
}

/// Build an `LlmRouter` from the persisted `LlmConfig`.
///
/// All `runtime in {openai-compat, llama-server, ollama}` providers are wired
/// through `OpenAiCompatProvider`. Providers with empty `api_key` AND non-local
/// runtime are still registered (so the user can fill the key later without a
/// restart) but they will fail at call-time.
///
/// Anthropic (`runtime=anthropic`) and Claude Code (`runtime=claude-cli`) are
/// not registered here — they are handled by their own modules.
///
/// `full_local_mode` filters out cloud providers entirely and forces task
/// routing to only fall through to local providers.
pub fn build_router(
    cfg: &LlmConfig,
    vault: Option<&crate::vault::Vault>,
    full_local_mode: bool,
) -> LlmRouter {
    let mut router = LlmRouter::new(&cfg.active);

    for (id, p) in &cfg.providers {
        if full_local_mode && !crate::ai::network_policy::is_local_runtime(&p.runtime) {
            tracing::info!(provider = %id, runtime = %p.runtime, "skipping cloud provider in full-local mode");
            continue;
        }
        match p.runtime.as_str() {
            "openai-compat" | "llama-server" | "ollama" => {
                let resolved_key = resolve_api_key(&p.api_key, vault);
                let provider = Arc::new(OpenAiCompatProvider::new(
                    id.as_str(),
                    p.base_url.clone(),
                    resolved_key,
                    p.model.clone(),
                ));
                router.add_provider(id, provider);
            }
            _ => {
                tracing::info!(provider = %id, runtime = %p.runtime, "skipping non-openai-compat provider in router");
            }
        }
    }

    for (task_str, provider_id) in &cfg.task_routing {
        if let Some(task) = task_kind_from_str(task_str) {
            // Only set the route if the target provider was actually registered.
            // (full_local_mode might have skipped it.)
            if router.has_provider(provider_id) {
                router.set_task_route(task, provider_id.clone());
            }
        }
    }

    if cfg.fallback.enabled
        && router.has_provider(&cfg.fallback.primary)
        && router.has_provider(&cfg.fallback.secondary)
    {
        router.set_fallback(FallbackConfig {
            primary:    cfg.fallback.primary.clone(),
            secondary:  cfg.fallback.secondary.clone(),
            timeout_ms: cfg.fallback.timeout_ms,
        });
    }

    router
}

/// Build a router from a full AiConfig (currently only forwards llm).
pub fn build_router_from_ai(cfg: &AiConfig, vault: Option<&crate::vault::Vault>) -> LlmRouter {
    build_router(&cfg.llm, vault, cfg.full_local_mode)
}

