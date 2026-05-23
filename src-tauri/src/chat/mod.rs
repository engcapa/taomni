pub mod redact;
pub mod store;

use crate::ai::config::{AiConfig, default_ai_config_path};
use crate::llm::{ChatMessage as LlmMessage, ChatRequest, ChatStreamEvent, TaskKind};
use crate::state::AppState;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Create a new chat thread.
#[tauri::command]
pub async fn chat_new_thread(
    provider_id: Option<String>,
    linked_session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<store::ChatThread, String> {
    let config = AiConfig::load(&default_ai_config_path());
    let pid = provider_id.unwrap_or_else(|| config.llm.active.clone());
    let thread = store::ChatThread {
        id: Uuid::new_v4().to_string(),
        title: "新对话".into(),
        provider_id: pid,
        created_at: now(),
        updated_at: now(),
        linked_session_id,
        source: "drawer".into(),
        cc_session_id: None,
    };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::create_thread(&db, &thread).map_err(|e| e.to_string())?;
    Ok(thread)
}

/// List recent chat threads.
#[tauri::command]
pub async fn chat_list_threads(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<store::ChatThread>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::list_threads(&db, limit.unwrap_or(50)).map_err(|e| e.to_string())
}

/// List messages in a thread.
#[tauri::command]
pub async fn chat_list_messages(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::ChatMessage>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::list_messages(&db, &thread_id).map_err(|e| e.to_string())
}

/// Delete a thread and all its messages.
#[tauri::command]
pub async fn chat_delete_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::delete_thread(&db, &thread_id).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatSendRequest {
    pub thread_id: String,
    pub content: String,
    /// Optional terminal content to attach as @terminal context.
    pub terminal_context: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChatSendResponse {
    pub user_message: store::ChatMessage,
    pub assistant_message: store::ChatMessage,
    pub redacted_count: usize,
}

/// Send a message and get a response (non-streaming for v2.4 static shell).
#[tauri::command]
pub async fn chat_send(
    req: ChatSendRequest,
    state: State<'_, AppState>,
) -> Result<ChatSendResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }

    // Load thread to get provider.
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let threads = store::list_threads(&db, 200).map_err(|e| e.to_string())?;
        let thread = threads.into_iter().find(|t| t.id == req.thread_id)
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };

    // Redact user content.
    let (clean_content, redacted_count) = redact::redact(&req.content);

    // Build LLM messages from history + new user message.
    let mut llm_messages: Vec<LlmMessage> = vec![
        LlmMessage::system("你是 NewMob 终端管理器的 AI 助手。帮助用户管理 SSH 会话、分析终端输出、生成 shell 命令。用中文回答，简洁清晰。"),
    ];

    // Add terminal context if provided.
    if let Some(ctx) = &req.terminal_context {
        let (clean_ctx, _) = redact::redact(ctx);
        llm_messages.push(LlmMessage::user(format!("[终端上下文]\n```\n{}\n```", clean_ctx)));
        llm_messages.push(LlmMessage::assistant("好的，我已看到终端内容。"));
    }

    // Add conversation history.
    for msg in &history {
        llm_messages.push(LlmMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
        });
    }
    llm_messages.push(LlmMessage::user(clean_content.clone()));

    // Route through LlmRouter — respects task routing + fallback + active provider.
    // The thread's provider_id picks the route: if it equals the configured
    // chat_drawer route, we go through ChatDrawer task; otherwise we ask the
    // router for that specific provider directly.
    let llm_req = ChatRequest {
        messages: llm_messages,
        max_tokens: Some(1024),
        temperature: Some(0.7),
        stream: false,
    };

    let resp = {
        let ai_ctx = state.ai_ctx.read().await;
        // Prefer the thread's pinned provider when available.
        if let Some(provider) = ai_ctx.llm.provider(&thread.provider_id) {
            provider.chat(llm_req).await.map_err(|e| e.to_string())?
        } else {
            // Fall back to the task-routed provider with timeout/fallback.
            ai_ctx.llm.complete(llm_req, TaskKind::ChatDrawer).await.map_err(|e| e.to_string())?
        }
    };

    // Persist both messages.
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_content,
        created_at: ts,
        redacted: redacted_count > 0,
    };
    let assistant_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: resp.content,
        created_at: ts + 1,
        redacted: false,
    };

    // Auto-title thread from first user message.
    let is_first = history.is_empty();

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if is_first {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    Ok(ChatSendResponse { user_message: user_msg, assistant_message: assistant_msg, redacted_count })
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEventOut {
    /// User message persisted; frontend can render it immediately.
    UserMessage { message: store::ChatMessage },
    /// Assistant message id allocated; tokens will follow under this id.
    AssistantStart { id: String, thread_id: String, created_at: i64 },
    /// One token (or token group) of the assistant response.
    Token { id: String, content: String },
    /// Stream ended cleanly; assistant message persisted.
    End { id: String, thread_id: String, content: String, redacted_count: usize },
    /// Stream ended with an error (assistant message NOT persisted).
    Error { id: String, message: String },
}

/// Streaming variant of `chat_send`. Emits events on
/// `chat-stream:{thread_id}` and resolves once the stream finishes (or errors).
#[tauri::command]
pub async fn chat_stream(
    req: ChatSendRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }

    let event_name = format!("chat-stream:{}", req.thread_id);
    let emit = |evt: &StreamEventOut| {
        let _ = app.emit(&event_name, evt.clone());
    };

    // Load thread + history.
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let threads = store::list_threads(&db, 200).map_err(|e| e.to_string())?;
        let thread = threads.into_iter().find(|t| t.id == req.thread_id)
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };

    let (clean_content, redacted_count) = redact::redact(&req.content);

    // Persist user message immediately.
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_content.clone(),
        created_at: ts,
        redacted: redacted_count > 0,
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
    }
    emit(&StreamEventOut::UserMessage { message: user_msg.clone() });

    // Build the LLM request.
    let mut llm_messages: Vec<LlmMessage> = vec![
        LlmMessage::system("你是 NewMob 终端管理器的 AI 助手。帮助用户管理 SSH 会话、分析终端输出、生成 shell 命令。用中文回答，简洁清晰。"),
    ];
    if let Some(ctx) = &req.terminal_context {
        let (clean_ctx, _) = redact::redact(ctx);
        llm_messages.push(LlmMessage::user(format!("[终端上下文]\n```\n{}\n```", clean_ctx)));
        llm_messages.push(LlmMessage::assistant("好的，我已看到终端内容。"));
    }
    for msg in &history {
        llm_messages.push(LlmMessage { role: msg.role.clone(), content: msg.content.clone() });
    }
    llm_messages.push(LlmMessage::user(clean_content));

    let llm_req = ChatRequest {
        messages: llm_messages,
        max_tokens: Some(1024),
        temperature: Some(0.7),
        stream: true,
    };

    // Allocate the assistant message id and begin streaming.
    let assistant_id = Uuid::new_v4().to_string();
    let assistant_ts = now() + 1;
    emit(&StreamEventOut::AssistantStart {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        created_at: assistant_ts,
    });

    // Pull the provider via the router so we don't hold the read lock across
    // the long stream lifetime.
    let stream_result = {
        let ai_ctx = state.ai_ctx.read().await;
        let provider = ai_ctx
            .llm
            .provider(&thread.provider_id)
            .or_else(|| ai_ctx.llm.provider(&ai_ctx.llm.provider_for_task(TaskKind::ChatDrawer)));
        match provider {
            Some(p) => p.chat_stream(llm_req).await,
            None => Err(crate::llm::LlmError::Provider {
                status: 0,
                message: "No provider available".into(),
            }),
        }
    };

    let mut stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            emit(&StreamEventOut::Error { id: assistant_id, message: e.to_string() });
            return Ok(());
        }
    };

    let mut accumulated = String::new();
    while let Some(evt) = stream.next().await {
        match evt {
            Ok(ChatStreamEvent::Token { content }) => {
                accumulated.push_str(&content);
                emit(&StreamEventOut::Token { id: assistant_id.clone(), content });
            }
            Ok(ChatStreamEvent::End { .. }) => break,
            Ok(ChatStreamEvent::Error { message }) => {
                emit(&StreamEventOut::Error { id: assistant_id, message });
                return Ok(());
            }
            Err(e) => {
                emit(&StreamEventOut::Error { id: assistant_id, message: e.to_string() });
                return Ok(());
            }
        }
    }

    // Persist the assistant message and auto-title on first turn.
    let assistant_msg = store::ChatMessage {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: accumulated.clone(),
        created_at: assistant_ts,
        redacted: false,
    };

    let is_first = history.is_empty();
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if is_first {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    emit(&StreamEventOut::End {
        id: assistant_id,
        thread_id: req.thread_id,
        content: accumulated,
        redacted_count,
    });

    Ok(())
}
