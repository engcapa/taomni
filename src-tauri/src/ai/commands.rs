use crate::ai::config::{AiConfig, LlmProviderConfig, default_ai_config_path};
use crate::ai::shell_safety::{check_blacklist, RiskLevel};
use crate::ai::shell_prompt::SHELL_COMMAND_SYSTEM_PROMPT;
use crate::ai::tools_shell::GeneratedCommand;
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

/// Generate a shell command from a natural language description.
/// Returns a CommandPreview for the frontend to display in the confirm card.
#[tauri::command]
pub async fn generate_shell_command(
    description: String,
    cwd: Option<String>,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<CommandPreview, String> {
    let ai_config = AiConfig::load(&default_ai_config_path());
    let routing_key = "voice_to_shell";
    let provider_id = ai_config.llm.task_routing
        .get(routing_key)
        .cloned()
        .unwrap_or_else(|| ai_config.llm.active.clone());

    let provider_cfg = ai_config.llm.providers.get(&provider_id)
        .ok_or_else(|| format!("Provider '{}' not configured", provider_id))?;

    let llm: Arc<dyn Llm> = Arc::new(OpenAiCompatProvider::new(
        &provider_id,
        &provider_cfg.base_url,
        &provider_cfg.api_key,
        &provider_cfg.model,
    ));

    let cwd_str = cwd.as_deref().unwrap_or("~");
    let user_msg = format!(
        "当前工作目录：{}\n\n用户请求：{}",
        cwd_str, description
    );

    // Build a request that instructs the LLM to respond with JSON matching GeneratedCommand.
    // We use a structured prompt since we can't rely on tool_calls being available on all providers.
    let system = format!(
        "{}\n\n请以 JSON 格式回复，包含字段：command (string), explanation (string), risk (\"low\"|\"medium\"|\"high\"), needs_inputs (array of strings)。只输出 JSON，不要其他文字。",
        SHELL_COMMAND_SYSTEM_PROMPT
    );

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system(system),
            ChatMessage::user(user_msg),
        ],
        max_tokens: Some(512),
        temperature: Some(0.2),
        stream: false,
    };

    let resp = llm.chat(req).await.map_err(|e| e.to_string())?;

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
    let outcome = if safety.blocked { "blocked_blacklist" } else { "generated" };

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
        blocked: safety.blocked,
        blocked_reason: safety.reason,
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
    ).map_err(|e| e.to_string())?;
    Ok(())
}
