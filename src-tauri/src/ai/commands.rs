use crate::ai::config::{AiConfig, LlmProviderConfig, default_ai_config_path};
use crate::ai::shell_prompt::SHELL_COMMAND_SYSTEM_PROMPT;
use crate::ai::shell_safety::{RiskLevel, check_blacklist};
use crate::ai::tools_shell::GeneratedCommand;
use crate::llm::anthropic::AnthropicProvider;
use crate::llm::openai_compat::OpenAiCompatProvider;
use crate::llm::{ChatMessage, ChatRequest, Llm};
use crate::state::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u64,
}

/// The preview card data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandPreview {
    pub command: String,
    pub explanation: String,
    pub risk: RiskLevel,
    pub needs_inputs: Vec<String>,
    /// True if the blacklist blocked execution (card still shown for editing).
    pub blocked: bool,
    pub blocked_reason: Option<String>,
    pub audit_id: i64,
}

/// Get the current AI configuration.
#[tauri::command]
pub async fn get_ai_config() -> Result<AiConfig, String> {
    let path = default_ai_config_path();
    Ok(AiConfig::load(&path))
}

/// Save the AI configuration. Rebuilds the LlmRouter so changes take
/// effect immediately without an app restart.
#[tauri::command]
pub async fn save_ai_config(
    mut config: AiConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = default_ai_config_path();
    config.normalize();
    config.save(&path).map_err(|e| e.to_string())?;

    let llm = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::llm::router::build_router_from_ai_with_proxy_db(
            &config,
            Some(state.vault.as_ref()),
            Some(&db),
        )
    };
    let mut ai_ctx = state.ai_ctx.write().await;
    ai_ctx.update_inspector_policy(&config);
    if config.fully_disabled || ai_ctx.config.asr != config.asr {
        crate::voice::commands::cancel_all();
    }
    ai_ctx.reload_with_router(config, llm);
    Ok(())
}

/// Store an AI provider's API key in the vault and return its `vault:<id>`
/// reference. The frontend should write this reference into the provider
/// config in place of the plaintext key.
///
/// `kind` is e.g. `ai_api_key:deepseek` / `ai_api_key:tavily`.
#[tauri::command]
pub async fn save_ai_api_key(
    kind: String,
    label: String,
    plaintext: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let result = state.vault.put(&kind, &label, &plaintext)?;
    Ok(result.reference)
}

/// Test connectivity to a specific LLM provider.
#[tauri::command]
pub async fn test_llm_connection(
    provider: LlmProviderConfig,
    state: State<'_, AppState>,
) -> Result<TestConnectionResult, String> {
    test_provider_connection(provider, &state, None).await
}

async fn test_provider_connection(
    provider: LlmProviderConfig,
    state: &AppState,
    deadline: Option<std::time::Duration>,
) -> Result<TestConnectionResult, String> {
    if provider.runtime == "opencode-go" {
        let ctx = state.ai_ctx.read().await;
        if ctx.config.full_local_mode || ctx.config.fully_disabled {
            return Err("OpenCode Go is disabled by the AI network policy".into());
        }
    }
    let test_api_key = provider
        .effective_api_keys()
        .into_iter()
        .next()
        .unwrap_or(provider.api_key.as_str())
        .to_string();
    // Resolve `vault:<id>` references into plaintext for the test call.
    // If the vault is locked we surface VAULT_LOCKED so the frontend can
    // prompt for unlock instead of sending the literal `vault:<uuid>` as the
    // bearer token (which would always 401).
    let api_key = if test_api_key.starts_with(crate::vault::VAULT_REF_PREFIX) {
        match state.vault.resolve(&test_api_key) {
            Ok(Some(plaintext)) => plaintext.to_string(),
            Ok(None) if deadline.is_some() => return Err("Credential reference was not found".into()),
            Ok(None) => test_api_key.clone(),
            Err(e) => {
                if e.contains(crate::vault::ERR_VAULT_LOCKED) {
                    return Err(format!("VAULT_LOCKED: {e}"));
                }
                return Err(e);
            }
        }
    } else {
        test_api_key
    };

    let proxy_url = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        if provider.runtime == "opencode-go" || deadline.is_some() {
            crate::ai::config::resolve_go_proxy_url(&provider, Some(&db), Some(&state.vault))
                .map_err(|error| if deadline.is_some() { error.replace("OpenCode Go", "Model check") } else { error })?
        } else {
            crate::ai::config::resolve_provider_proxy_url(&provider, Some(&db), Some(&state.vault))?
        }
    };

    let llm: Arc<dyn Llm> = match provider.runtime.as_str() {
        "opencode-go" => Arc::new(crate::llm::opencode_go::OpenCodeGoProvider::new(
            "opencode-go".into(), provider.base_url.clone(), api_key.clone(),
            provider.model.clone(), proxy_url, state.opencode_go_catalog.clone(),
            provider.protocol_overrides.clone(),
        )),
        "anthropic" => {
            let base_url = if provider.base_url.is_empty() {
                "https://api.anthropic.com/v1".to_string()
            } else {
                provider.base_url.clone()
            };
            Arc::new(AnthropicProvider::new_with_proxy_url(
                "test",
                base_url,
                &api_key,
                &provider.model,
                proxy_url,
            ))
        }
        _ => Arc::new(OpenAiCompatProvider::new_with_proxy_url(
            "test",
            &provider.base_url,
            &api_key,
            &provider.model,
            proxy_url,
        )),
    };

    let blocked = if deadline.is_some() {
        let ctx = state.ai_ctx.read().await;
        crate::ai::model_inspector::checks_disabled(&provider.runtime, ctx.config.full_local_mode, ctx.config.fully_disabled)
    } else { false };
    let (ok, mut message, latency_ms) = crate::ai::model_inspector::guarded_probe(llm.as_ref(), blocked, deadline).await?;
    // A gateway can echo a credential in its error. Never persist it in the inspector.
    if deadline.is_some() && !api_key.is_empty() { message = message.replace(&api_key, "[redacted]"); }
    Ok(TestConnectionResult { ok, message, latency_ms })
}

#[tauri::command]
pub async fn test_llm_model(
    provider_id: String,
    model: String,
    provider_draft: Option<LlmProviderConfig>,
    state: State<'_, AppState>,
) -> Result<crate::ai::model_inspector::CheckResult, String> {
    use crate::ai::model_inspector::{check_result, checks_disabled, save_result};
    if model.trim().is_empty() { return Err("Model ID is required".into()); }
    let (mut provider, cancel) = {
        let ctx = state.ai_ctx.read().await;
        let provider = crate::ai::model_inspector::inspector_provider(ctx.config.llm.providers.get(&provider_id).ok_or("Unknown provider")?, provider_draft)?;
        if checks_disabled(&provider.runtime, ctx.config.full_local_mode, ctx.config.fully_disabled) {
            return Err("Model checks are disabled by the AI network policy".into());
        }
        (provider, ctx.inspector_cancel.clone())
    };
    provider.model = model.clone();
    let start = std::time::Instant::now();
    let result = match crate::ai::model_inspector::under_policy(&cancel, test_provider_connection(provider, &state, Some(std::time::Duration::from_secs(60)))).await {
        Ok(result) => check_result(result.ok, result.latency_ms, (!result.ok).then_some(result.message)),
        Err(error) => check_result(false, start.elapsed().as_millis() as u64, Some(error)),
    };
    save_result(&default_ai_config_path().with_file_name("model-check-results.json"), &provider_id, &model, result.clone())?;
    Ok(result)
}

#[tauri::command]
pub async fn get_provider_models(
    provider_id: String,
    force_refresh: Option<bool>,
    provider_draft: Option<LlmProviderConfig>,
    state: State<'_, AppState>,
) -> Result<crate::ai::model_inspector::ProviderModelsDto, String> {
    use crate::ai::model_inspector::*;
    let (provider, full_local, disabled, cancel) = {
        let ctx = state.ai_ctx.read().await;
        (inspector_provider(ctx.config.llm.providers.get(&provider_id).ok_or("Unknown provider")?, provider_draft)?,
            ctx.config.full_local_mode, ctx.config.fully_disabled, ctx.inspector_cancel.clone())
    };
    let local = is_local(&provider.runtime);
    let blocked = checks_disabled(&provider.runtime, full_local, disabled);
    let request = async {
    let dto = if provider.runtime == "opencode-go" {
        let proxy = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            crate::ai::config::resolve_go_proxy_url(&provider, Some(&db), Some(state.vault.as_ref()))
        };
        let go = state.opencode_go_catalog.inspect(provider.base_url.clone(), proxy, blocked, force_refresh.unwrap_or(false)).await;
        ProviderModelsDto { rows: go_rows(&go, &provider.model, &provider.protocol_overrides),
            fetched_at: go.fetched_at, source: go.source, last_error: go.last_error,
            unavailable: false, checks_disabled: blocked }
    } else {
        let proxy = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            crate::ai::config::resolve_go_proxy_url(&provider, Some(&db), Some(state.vault.as_ref()))
                .map_err(|error| error.replace("OpenCode Go", "Model catalog"))
        };
        let catalog = state.opencode_go_catalog.metadata.refresh(proxy.clone(), blocked || local,
            force_refresh.unwrap_or(false), crate::llm::model_catalog::METADATA_URL).await;
        let mut live = None;
        let mut live_error = None;
        if !blocked && provider.runtime != "anthropic" {
            let key = provider.effective_api_keys().into_iter().next().unwrap_or(&provider.api_key);
            let key = if key.starts_with(crate::vault::VAULT_REF_PREFIX) {
                state.vault.resolve(key).map(|v| v.map(|k| k.to_string()).unwrap_or_default())
            } else { Ok(key.to_string()) };
            match (key, proxy) {
                (Ok(key), Ok(proxy)) => match live_models(&provider.base_url, &key, proxy.as_deref()).await {
                    Ok(ids) => live = Some(ids),
                    Err(error) => live_error = Some(error),
                },
                (Err(error), _) | (_, Err(error)) => live_error = Some(error),
            }
        }
        let key = provider_key(&provider_id, &provider.base_url);
        let snapshot: serde_json::Value = serde_json::from_str(crate::llm::model_catalog::SNAPSHOT).unwrap();
        ProviderModelsDto {
            rows: assemble(&provider.model, &provider.runtime, &catalog.providers[key], live.as_deref(), &snapshot["aliases"][key]),
            fetched_at: if local && live.is_some() { crate::llm::model_catalog::now() } else { catalog.fetched_at },
            source: if local && live.is_some() { "live".into() } else { catalog.source },
            last_error: live_error.or(catalog.last_error), unavailable: local && live.is_none(),
            checks_disabled: blocked,
        }
    };
    Ok(dto)
    };
    let mut dto = match under_policy(&cancel, request).await {
        Ok(dto) => dto,
        Err(error) if cancel.is_cancelled() => {
            let ctx = state.ai_ctx.read().await;
            let catalog = state.opencode_go_catalog.metadata.get();
            let snapshot: serde_json::Value = serde_json::from_str(crate::llm::model_catalog::SNAPSHOT).unwrap();
            let key = provider_key(&provider_id, &provider.base_url);
            ProviderModelsDto {
                rows: if provider.runtime == "opencode-go" {
                    go_rows(&state.opencode_go_catalog.get(), &provider.model, &provider.protocol_overrides)
                } else { assemble(&provider.model, &provider.runtime, &catalog.providers[key], None, &snapshot["aliases"][key]) },
                fetched_at: catalog.fetched_at, source: catalog.source, last_error: Some(error), unavailable: local,
                checks_disabled: checks_disabled(&provider.runtime, ctx.config.full_local_mode, ctx.config.fully_disabled),
            }
        }
        Err(error) => return Err(error),
    };
    attach_results(&mut dto.rows, &provider_id, &default_ai_config_path().with_file_name("model-check-results.json"));
    Ok(dto)
}

#[tauri::command]
pub async fn get_opencode_go_catalog(
    force_refresh: bool,
    state: State<'_, AppState>,
) -> Result<crate::llm::opencode_go::catalog::GoCatalogDto, String> {
    // Re-resolve policies and session proxies, not a stale UI snapshot.
    {
        let ctx = state.ai_ctx.read().await;
        if let Some(go) = ctx.config.llm.providers.get("opencode-go") {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            state.opencode_go_catalog.configure(go.base_url.clone(),
                crate::ai::config::resolve_go_proxy_url(go, Some(&db), Some(state.vault.as_ref())),
                ctx.config.full_local_mode || ctx.config.fully_disabled);
        }
    }
    if force_refresh { Ok(state.opencode_go_catalog.refresh(true).await) }
    else {
        state.opencode_go_catalog.trigger(false);
        Ok(state.opencode_go_catalog.get())
    }
}

/// Generate a shell command from a natural language description.
/// Returns a CommandPreview for the frontend to display in the confirm card.
#[tauri::command]
pub async fn generate_shell_command(
    description: String,
    cwd: Option<String>,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<CommandPreview, String> {
    let cwd_str = cwd.as_deref().unwrap_or("~");
    let user_msg = format!("当前工作目录：{}\n\n用户请求：{}", cwd_str, description);

    // Per-session "AI write actions disabled" flag — when set, we still
    // generate the preview but mark it blocked so the frontend disables
    // execution and only allows clipboard copy.
    let session_disabled = match session_id.as_deref() {
        Some(id) => crate::ai::session_safety::is_ai_write_disabled(state.inner(), id),
        None => false,
    };

    // Build a request that instructs the LLM to respond with JSON matching GeneratedCommand.
    // We use a structured prompt since we can't rely on tool_calls being available on all providers.
    let system = format!(
        "{}\n\n请以 JSON 格式回复，包含字段：command (string), explanation (string), risk (\"low\"|\"medium\"|\"high\"), needs_inputs (array of strings)。只输出 JSON，不要其他文字。",
        SHELL_COMMAND_SYSTEM_PROMPT
    );

    let req = ChatRequest {
        messages: vec![ChatMessage::system(system), ChatMessage::user(user_msg)],
        max_tokens: Some(512),
        temperature: Some(0.2),
        stream: false,
        ..Default::default()
    };

    // Route through LlmRouter using VoiceToShell task — gets fallback for free.
    let resp = {
        let ai_ctx = state.ai_ctx.read().await;
        ai_ctx
            .llm
            .complete(req, crate::llm::TaskKind::VoiceToShell)
            .await
            .map_err(|e| e.to_string())?
    };

    // Parse the JSON response — strip markdown code fences if present.
    let raw = resp.content.trim();
    let json_str = if raw.starts_with("```") {
        raw.lines()
            .skip(1)
            .take_while(|l| !l.starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        raw.to_string()
    };

    let generated: GeneratedCommand = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse LLM response as JSON: {e}\nRaw: {json_str}"))?;

    // Run blacklist check.
    let safety = check_blacklist(&generated.command);
    let final_blocked = safety.blocked || session_disabled;
    let blocked_reason = if safety.blocked {
        safety.reason.clone()
    } else if session_disabled {
        Some("会话级 AI 写动作已禁用：仅可复制到剪贴板，不会注入终端。".to_string())
    } else {
        None
    };
    let outcome = if safety.blocked {
        "blocked_blacklist"
    } else if session_disabled {
        "blocked_session"
    } else {
        "generated"
    };

    // Write audit log entry.
    let audit_id = {
        let db = state.db.lock().unwrap();
        let now = chrono::Utc::now().timestamp();
        db.execute(
            "INSERT INTO voice_audit (created_at, session_id, transcript, intent_json, outcome, command, risk)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                now,
                session_id,
                description,
                serde_json::to_string(&generated).ok(),
                outcome,
                generated.command,
                format!("{:?}", generated.risk).to_lowercase(),
            ],
        ).map_err(|e| e.to_string())?;
        db.last_insert_rowid()
    };

    Ok(CommandPreview {
        command: generated.command,
        explanation: generated.explanation,
        risk: generated.risk,
        needs_inputs: generated.needs_inputs,
        blocked: final_blocked,
        blocked_reason,
        audit_id,
    })
}

/// Update the audit log outcome after user action (executed/edited/cancelled).
#[tauri::command]
pub async fn update_shell_audit_outcome(
    audit_id: i64,
    outcome: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE voice_audit SET outcome = ?1 WHERE id = ?2",
        params![outcome, audit_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
