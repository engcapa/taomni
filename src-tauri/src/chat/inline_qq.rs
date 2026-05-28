// Backend command dedicated to the `??` inline-render path: takes a question
// string + emits LLM tokens via the chat-stream-style event protocol so the
// terminal can pipe them straight into xterm.write() without going through
// the chat database. Distinct from chat_send because there's no thread to
// persist into and no SQLite write — pure ephemeral inline rendering.

use crate::llm::{ChatMessage, ChatRequest, ChatStreamEvent, TaskKind};
use crate::state::AppState;
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InlineEvent {
    Token { content: String },
    End,
    Error { message: String },
}

/// Stream a quick AI answer for the terminal inline path. Emits events on
/// `inline-qq:{request_id}` until the stream ends. Called by the frontend
/// once it has intercepted `?? <question>` Enter and chosen the inline
/// render path.
#[tauri::command]
pub async fn inline_qq_stream(
    request_id: String,
    question: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }

    let event_name = format!("inline-qq:{}", request_id);
    let emit = |evt: &InlineEvent| {
        let _ = app.emit(&event_name, evt.clone());
    };

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system(
                "你是 NewMob 终端内联助手。用户在终端里直接问你问题，请简洁回答；\
                 不要使用 markdown 标记（终端是纯文本），直接给出答案。\
                 如果建议命令，请用反引号包起来。",
            ),
            ChatMessage::user(question),
        ],
        max_tokens: Some(512),
        temperature: Some(0.4),
        stream: true,
    };

    // Pull provider via the router.
    let stream_result = {
        let ai_ctx = state.ai_ctx.read().await;
        let provider_id = ai_ctx.llm.provider_for_task(TaskKind::InlineQq);
        let provider = ai_ctx
            .llm
            .provider(&provider_id)
            .or_else(|| ai_ctx.llm.provider(ai_ctx.llm.active()));
        match provider {
            Some(p) => p.chat_stream(req).await,
            None => {
                // Surface VAULT_LOCKED if the routed provider is just locked,
                // so the frontend can prompt for unlock.
                let locked_id = if ai_ctx.llm.needs_vault_unlock(&provider_id) {
                    Some(provider_id.clone())
                } else if ai_ctx.llm.needs_vault_unlock(ai_ctx.llm.active()) {
                    Some(ai_ctx.llm.active().to_string())
                } else {
                    None
                };
                match locked_id {
                    Some(id) => Err(crate::llm::LlmError::VaultLocked { provider: id }),
                    None => Err(crate::llm::LlmError::Provider {
                        status: 0,
                        message: "No provider available".into(),
                    }),
                }
            }
        }
    };

    let mut stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            emit(&InlineEvent::Error {
                message: e.to_string(),
            });
            return Ok(());
        }
    };

    while let Some(evt) = stream.next().await {
        match evt {
            Ok(ChatStreamEvent::Token { content }) => {
                emit(&InlineEvent::Token { content });
            }
            Ok(ChatStreamEvent::End { .. }) => break,
            Ok(ChatStreamEvent::Error { message }) => {
                emit(&InlineEvent::Error { message });
                return Ok(());
            }
            Err(e) => {
                emit(&InlineEvent::Error {
                    message: e.to_string(),
                });
                return Ok(());
            }
        }
    }

    emit(&InlineEvent::End);
    Ok(())
}
