pub mod actions;
pub mod context;
pub mod types;

use crate::llm::{ChatMessage, ChatRequest, Llm};
use crate::state::AppState;
use futures::StreamExt;
use tauri::State;
use types::{TaoEvent, TaoRequest, TaoResponse};

/// Sends one Tao turn through the dedicated DeepSeek Messages provider. The
/// provider is registered independently from the legacy OpenAI-compatible
/// route; structured events are returned so the renderer can keep its own
/// instance-scoped state machine.
#[tauri::command]
pub async fn deepseek_app_send(
    request: TaoRequest,
    state: State<'_, AppState>,
) -> Result<TaoResponse, String> {
    let provider = {
        let ctx = state.ai_ctx.read().await;
        if !ctx.config.deepseek_app.enabled {
            return Err("DeepSeek · 全家桶 已在设置中停用".to_string());
        }
        ctx.llm
            .provider("deepseek-app")
            .ok_or_else(|| "DeepSeek · 全家桶 未配置或 Vault 已锁定".to_string())?
    };

    let (question, _) = crate::chat::redact::redact(&request.content);
    let mut context_lines = Vec::new();
    for (key, value) in request.context {
        if let Some(value) = value.as_str() {
            let (safe, _) = crate::chat::redact::redact(value);
            context_lines.push(format!("{key}: {safe}"));
        }
    }
    let context_hint = if context_lines.is_empty() {
        String::new()
    } else {
        format!(
            "\n已绑定上下文（仅在本轮提供，均已脱敏）：\n{}",
            context_lines.join("\n")
        )
    };
    let mode_hint = match request.mode.as_str() {
        "do" => "需要操作时，只输出 fenced `tao-action` JSON 提议，绝不要声称已经执行。",
        "research" => "先给出可取消的研究计划，再分步骤回答；标明联网来源。",
        _ => "直接回答问题，必要时用清晰的步骤和代码。",
    };
    let web_hint = if request.web {
        "联网能力已打开；联网失败要明确说明，不能静默直连。"
    } else {
        "不要调用联网能力。"
    };
    let system = format!(
        "你是 Tao（Develop Buddy）。模式：{}。{} {}{}",
        request.mode, mode_hint, web_hint, context_hint
    );
    let req = ChatRequest {
        messages: vec![ChatMessage::system(system), ChatMessage::user(question)],
        max_tokens: Some(8192),
        temperature: None,
        stream: true,
        model_override: Some(request.model),
        session_key: Some(request.thread_id),
    };
    let mut stream = provider
        .chat_stream(req)
        .await
        .map_err(|error| error.to_string())?;
    let mut events = vec![TaoEvent::new("message_start").with("model", provider.model())];
    events.push(
        TaoEvent::new("block_start")
            .with("index", 0)
            .with("block", serde_json::json!({"type":"text"})),
    );
    while let Some(item) = stream.next().await {
        match item.map_err(|error| error.to_string())? {
            crate::llm::ChatStreamEvent::Token { content } => {
                events.push(
                    TaoEvent::new("block_delta")
                        .with("index", 0)
                        .with("delta", serde_json::json!({"text":content})),
                );
            }
            crate::llm::ChatStreamEvent::End { model, usage } => {
                if let Some(usage) = usage {
                    events.push(TaoEvent::new("message_delta").with("stop_reason", "end_turn").with("usage", serde_json::json!({"inputTokens": usage.prompt_tokens, "outputTokens": usage.completion_tokens})));
                } else {
                    events.push(TaoEvent::new("message_delta").with("stop_reason", "end_turn"));
                }
                if let Some(model) = model {
                    events[0] = events[0].clone().with("model", model);
                }
            }
            crate::llm::ChatStreamEvent::Error { message } => {
                events.push(
                    TaoEvent::new("error")
                        .with("category", "stream")
                        .with("message", message),
                );
            }
        }
    }
    events.push(TaoEvent::new("block_stop").with("index", 0));
    if !events.iter().any(|event| event.kind == "message_delta") {
        events.push(TaoEvent::new("message_delta").with("stop_reason", "end_turn"));
    }
    events.push(TaoEvent::new("message_stop"));
    Ok(TaoResponse { events })
}

#[tauri::command]
pub async fn deepseek_app_stop(_thread_id: String) -> Result<(), String> {
    Ok(())
}
