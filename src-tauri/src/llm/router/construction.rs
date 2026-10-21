use super::groups::provider_group_route_id;
use super::routing::FallbackConfig;
use super::routing::LlmRouter;
use super::routing::task_kind_from_str;
use crate::ai::config::AiConfig;
use crate::ai::config::LlmConfig;
use crate::ai::config::resolve_provider_proxy_url;
use crate::llm::Llm;
use crate::llm::anthropic::AnthropicProvider;
use crate::llm::openai_compat::OpenAiCompatProvider;
use std::sync::Arc;

/// Resolve a possibly `vault:<id>`-prefixed value to plaintext.
///
/// Returns:
/// - `Ok(plaintext)` when the value is plaintext, or a vault ref that
///   resolves cleanly.
/// - `Err(())` when the value IS a vault ref but the vault is locked, the
///   entry is missing, or decryption failed. The caller must NOT fall back
///   to using the literal `vault:<id>` string as a credential — that's how
///   we end up with bogus 401s on app start.
pub(super) fn resolve_api_key(
    value: &str,
    vault: Option<&crate::vault::Vault>,
) -> Result<String, ()> {
    let is_ref = value.starts_with(crate::vault::VAULT_REF_PREFIX);
    if !is_ref {
        return Ok(value.to_string());
    }
    let v = match vault {
        Some(v) => v,
        // We have a vault ref but no Vault handle — treat as unresolved.
        None => return Err(()),
    };
    match v.resolve(value) {
        Ok(Some(plaintext)) => Ok(plaintext.to_string()),
        // Plaintext path — `resolve` returns Ok(None) only when the input is
        // not a vault ref, which we already excluded above. Belt-and-braces.
        Ok(None) => Ok(value.to_string()),
        Err(_) => Err(()),
    }
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
    build_router_with_proxy_db(cfg, vault, full_local_mode, None)
}

pub fn build_router_with_proxy_db(
    cfg: &LlmConfig,
    vault: Option<&crate::vault::Vault>,
    full_local_mode: bool,
    proxy_db: Option<&rusqlite::Connection>,
) -> LlmRouter {
    let mut router = LlmRouter::new(&cfg.active);
    let go_catalog = crate::llm::opencode_go::catalog::shared_catalog();
    if let Some(go) = cfg.providers.get("opencode-go") {
        go_catalog.configure(
            go.base_url.clone(),
            crate::ai::config::resolve_go_proxy_url(go, proxy_db, vault),
            full_local_mode,
        );
    }

    for (id, p) in &cfg.providers {
        if !p.capabilities.chat {
            tracing::info!(provider = %id, "skipping provider without chat capability in LLM router");
            continue;
        }
        if full_local_mode && !crate::ai::network_policy::is_local_runtime(&p.runtime) {
            tracing::info!(provider = %id, runtime = %p.runtime, "skipping cloud provider in full-local mode");
            continue;
        }

        if !matches!(
            p.runtime.as_str(),
            "openai-compat" | "llama-server" | "ollama" | "anthropic" | "opencode-go"
        ) {
            tracing::info!(provider = %id, runtime = %p.runtime, "skipping non-openai-compat provider in router");
            continue;
        }

        let proxy_result = if p.runtime == "opencode-go" {
            crate::ai::config::resolve_go_proxy_url(p, proxy_db, vault)
        } else {
            resolve_provider_proxy_url(p, proxy_db, vault)
        };
        let proxy_error = proxy_result.as_ref().err().cloned();
        let proxy_url = match proxy_result {
            Ok(proxy_url) => proxy_url,
            Err(e) => {
                tracing::warn!(provider = %id, error = %e, "provider proxy resolution failed; requests fail closed");
                None
            }
        };

        let mut variants: Vec<Arc<dyn Llm>> = Vec::new();
        let mut unresolved_key = false;
        for api_key in p.effective_api_keys() {
            let resolved_key = match resolve_api_key(api_key, vault) {
                Ok(k) => k,
                Err(()) => {
                    unresolved_key = true;
                    tracing::warn!(
                        provider = %id,
                        "api key vault reference could not be resolved (vault locked?) — key skipped"
                    );
                    continue;
                }
            };

            let provider: Arc<dyn Llm> = match p.runtime.as_str() {
                _ if proxy_error.is_some() => crate::llm::opencode_go::unavailable(
                    id.clone(),
                    p.model.clone(),
                    proxy_error.clone().unwrap(),
                ),
                "opencode-go" => Arc::new(crate::llm::opencode_go::OpenCodeGoProvider::new(
                    id.clone(),
                    p.base_url.clone(),
                    resolved_key,
                    p.model.clone(),
                    proxy_url.clone(),
                    go_catalog.clone(),
                    p.protocol_overrides.clone(),
                )),
                "openai-compat" | "llama-server" | "ollama" => {
                    Arc::new(OpenAiCompatProvider::new_with_proxy_url(
                        id.as_str(),
                        p.base_url.clone(),
                        resolved_key,
                        p.model.clone(),
                        proxy_url.clone(),
                    ))
                }
                "anthropic" => {
                    let base_url = if p.base_url.is_empty() {
                        "https://api.anthropic.com/v1".to_string()
                    } else {
                        p.base_url.clone()
                    };
                    Arc::new(AnthropicProvider::new_with_proxy_url(
                        id.as_str(),
                        base_url,
                        resolved_key,
                        p.model.clone(),
                        proxy_url.clone(),
                    ))
                }
                _ => unreachable!("runtime was checked above"),
            };
            variants.push(provider);
        }

        if variants.is_empty() {
            if unresolved_key {
                tracing::warn!(
                    provider = %id,
                    "all api keys were unresolved — provider not registered"
                );
                router.mark_unresolved(id);
            }
        } else {
            router.add_provider_variants(id.clone(), variants);
        }
    }

    for (group_id, group) in &cfg.provider_groups {
        if !group.enabled {
            continue;
        }
        router.add_provider_group(group_id.clone(), group.provider_ids.clone());
        let route_id = provider_group_route_id(group_id);
        if !router.has_provider(&route_id)
            && group
                .provider_ids
                .iter()
                .any(|provider_id| router.needs_vault_unlock(provider_id))
        {
            router.mark_unresolved(route_id);
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
            primary: cfg.fallback.primary.clone(),
            secondary: cfg.fallback.secondary.clone(),
            timeout_ms: cfg.fallback.timeout_ms,
        });
    }

    router
}

/// Build a router from a full AiConfig (currently only forwards llm).
pub fn build_router_from_ai(cfg: &AiConfig, vault: Option<&crate::vault::Vault>) -> LlmRouter {
    build_router_from_ai_with_proxy_db(cfg, vault, None)
}

pub fn build_router_from_ai_with_proxy_db(
    cfg: &AiConfig,
    vault: Option<&crate::vault::Vault>,
    proxy_db: Option<&rusqlite::Connection>,
) -> LlmRouter {
    let router = build_router_with_proxy_db(&cfg.llm, vault, cfg.full_local_mode, proxy_db);
    if cfg.fully_disabled {
        if let Some(go) = cfg.llm.providers.get("opencode-go") {
            crate::llm::opencode_go::catalog::shared_catalog().configure(
                go.base_url.clone(),
                crate::ai::config::resolve_go_proxy_url(go, proxy_db, vault),
                true,
            );
        }
    }
    router
}
