use super::groups::ProviderGroupLlm;
use super::groups::ProviderGroupState;
use super::groups::provider_group_route_id;
use super::rotation::KeyRotatingLlm;
use super::rotation::KeyRotationState;
use crate::llm::ChatRequest;
use crate::llm::ChatResponse;
use crate::llm::Llm;
use crate::llm::LlmError;
use crate::llm::LlmResult;
use crate::llm::TaskKind;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;

/// Routes a chat request to the appropriate provider based on task kind,
/// with optional timeout + fallback to a secondary provider.
pub struct LlmRouter {
    pub(super) providers: HashMap<String, Arc<dyn Llm>>,
    pub(super) provider_key_states: HashMap<String, Arc<KeyRotationState>>,
    pub(super) provider_groups: HashMap<String, Arc<ProviderGroupState>>,
    pub(super) task_routing: HashMap<TaskKind, String>,
    pub(super) active: String,
    pub(super) fallback: Option<FallbackConfig>,
    /// Provider ids whose api_key is a `vault:<id>` reference that could not
    /// be resolved when the router was built (vault locked / entry missing).
    /// They are intentionally NOT registered in `providers` so calls fail
    /// closed with [`LlmError::VaultLocked`] instead of silently sending the
    /// literal `vault:<uuid>` string as the bearer token (which produced 401s).
    pub(super) unresolved: HashSet<String>,
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
            provider_key_states: HashMap::new(),
            provider_groups: HashMap::new(),
            task_routing: HashMap::new(),
            active: active.into(),
            fallback: None,
            unresolved: HashSet::new(),
        }
    }

    pub fn add_provider(&mut self, id: impl Into<String>, provider: Arc<dyn Llm>) {
        self.providers.insert(id.into(), provider);
    }

    pub fn add_provider_variants(&mut self, id: impl Into<String>, variants: Vec<Arc<dyn Llm>>) {
        let id = id.into();
        let key_state = self
            .provider_key_states
            .entry(id.clone())
            .or_insert_with(|| Arc::new(KeyRotationState::new()))
            .clone();
        match variants.len() {
            0 => {}
            1 => {
                let provider = variants.into_iter().next().expect("checked len");
                self.add_provider(id, provider);
            }
            _ => {
                self.providers.insert(
                    id.clone(),
                    Arc::new(KeyRotatingLlm::new(id, variants, key_state)),
                );
            }
        }
    }

    pub fn add_provider_group(&mut self, group_id: impl Into<String>, provider_ids: Vec<String>) {
        let route_id = provider_group_route_id(&group_id.into());
        let provider_ids = provider_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        if provider_ids.is_empty() {
            return;
        }

        let state = Arc::new(ProviderGroupState::new(provider_ids.clone()));
        let providers = provider_ids
            .iter()
            .filter_map(|id| {
                self.providers
                    .get(id)
                    .cloned()
                    .map(|provider| (id.clone(), provider))
            })
            .collect::<HashMap<_, _>>();
        if !providers.is_empty() {
            self.providers.insert(
                route_id.clone(),
                Arc::new(ProviderGroupLlm::new(
                    route_id.clone(),
                    state.clone(),
                    providers,
                )),
            );
        }
        self.provider_groups.insert(route_id, state);
    }

    pub fn provider_group_len(&self, route_id: &str) -> Option<usize> {
        self.provider_groups.get(route_id).map(|group| group.len())
    }

    pub fn next_provider_in_group(&self, route_id: &str) -> Option<String> {
        self.provider_groups
            .get(route_id)
            .and_then(|group| group.next_provider_id())
    }

    pub fn next_key_index(&self, provider_id: &str, key_count: usize) -> usize {
        self.provider_key_states
            .get(provider_id)
            .map(|state| state.next_key_index(key_count))
            .unwrap_or(0)
    }

    /// Mark a provider id as blocked on a locked vault. The frontend can call
    /// `needs_vault_unlock(id)` to decide whether to surface the unlock
    /// dialog before invoking a chat command.
    pub fn mark_unresolved(&mut self, id: impl Into<String>) {
        self.unresolved.insert(id.into());
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

    /// True if this provider is known to need a vault unlock to be usable.
    pub fn needs_vault_unlock(&self, id: &str) -> bool {
        self.unresolved.contains(id)
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
        let primary_id = self.task_routing.get(&task).unwrap_or(&self.active).clone();

        let primary = match self.providers.get(&primary_id) {
            Some(p) => p,
            None => {
                if self.unresolved.contains(&primary_id) {
                    return Err(LlmError::VaultLocked {
                        provider: primary_id,
                    });
                }
                return Err(LlmError::NoProvider(task));
            }
        };

        // If fallback is configured and primary matches the fallback primary, apply timeout.
        if let Some(fb) = &self.fallback {
            if primary_id == fb.primary {
                let result = timeout(
                    Duration::from_millis(fb.timeout_ms),
                    primary.chat(req.clone()),
                )
                .await;

                match result {
                    Ok(Ok(resp)) => return Ok(resp),
                    Ok(Err(e)) => {
                        tracing::warn!(provider = %primary_id, error = %e, "primary LLM failed, falling back");
                    }
                    Err(_) => {
                        tracing::warn!(provider = %primary_id, timeout_ms = fb.timeout_ms, "primary LLM timed out, falling back");
                    }
                }

                let secondary = match self.providers.get(&fb.secondary) {
                    Some(p) => p,
                    None => {
                        if self.unresolved.contains(&fb.secondary) {
                            return Err(LlmError::VaultLocked {
                                provider: fb.secondary.clone(),
                            });
                        }
                        return Err(LlmError::NoProvider(task));
                    }
                };
                return secondary.chat(req).await;
            }
        }

        primary.chat(req).await
    }

    /// Test connectivity to a provider by sending a minimal ping request.
    pub async fn test_connection(&self, provider_id: &str) -> LlmResult<String> {
        let provider = self
            .providers
            .get(provider_id)
            .ok_or_else(|| LlmError::NoProvider(TaskKind::ChatDrawer))?;

        let req = ChatRequest::simple("You are a test assistant.", "Reply with exactly: pong");
        let resp = timeout(Duration::from_secs(10), provider.chat(req))
            .await
            .map_err(|_| LlmError::Timeout { ms: 10_000 })??;

        Ok(resp.content)
    }
}

pub(super) fn task_kind_from_str(s: &str) -> Option<TaskKind> {
    Some(match s {
        "voice_intent" => TaskKind::VoiceIntent,
        "voice_to_shell" => TaskKind::VoiceToShell,
        "tab_completion" => TaskKind::TabCompletion,
        "command_rewrite" => TaskKind::CommandRewrite,
        "chat_drawer" => TaskKind::ChatDrawer,
        "inline_qq" => TaskKind::InlineQq,
        "agent_default" => TaskKind::AgentDefault,
        "web_search" => TaskKind::WebSearch,
        "code_mode" => TaskKind::CodeMode,
        _ => return None,
    })
}
