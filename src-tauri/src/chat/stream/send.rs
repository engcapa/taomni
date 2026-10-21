use crate::ai::config::AiConfig;
use crate::ai::config::default_ai_config_path;
use crate::chat::ChatSendRequest;
use crate::chat::ChatSendResponse;
use crate::chat::attachments;
use crate::chat::attachments::build_llm_attachment_message;
use crate::chat::attachments::validate_chat_attachments;
use crate::chat::now;
use crate::chat::redact;
use crate::chat::store;
use crate::chat::thread_commands::build_system_prompt;
use crate::chat::thread_commands::resolve_output_format;
use crate::chat::thread_commands::thread_session_key;
use crate::llm::ChatMessage as LlmMessage;
use crate::llm::ChatRequest;
use crate::llm::TaskKind;
use crate::llm::router::provider_group_id_from_route;
use crate::state::AppState;
use futures::StreamExt;
use std::io::Read;
use tauri::State;
use uuid::Uuid;

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
    let attachments = validate_chat_attachments(&req.attachments)?;

    // Load thread to get provider.
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = store::get_thread(&db, &req.thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };
    if thread.mode != "chat" {
        return Err(format!(
            "Thread '{}' is a {} generation thread; use media generation.",
            thread.id, thread.mode
        ));
    }

    // Redact user content.
    let (clean_content, redacted_count) = redact::redact(&req.content);

    // Resolve the effective output format and build the system prompt around it.
    let ai_config = AiConfig::load(&default_ai_config_path());
    let output_format = resolve_output_format(&thread, &ai_config);
    let system_prompt = build_system_prompt(&output_format);

    // Build LLM messages from history + new user message.
    let mut llm_messages: Vec<LlmMessage> = vec![LlmMessage::system(system_prompt)];

    // Add terminal context if provided.
    if let Some(ctx) = &req.terminal_context {
        let (clean_ctx, _) = redact::redact(ctx);
        llm_messages.push(LlmMessage::user(format!(
            "[Terminal context]\n```\n{}\n```",
            clean_ctx
        )));
        llm_messages.push(LlmMessage::assistant(
            "Acknowledged — I have read the terminal output.",
        ));
    }

    // Add conversation history.
    for msg in &history {
        llm_messages.push(LlmMessage {
            role: msg.role.clone(),
            content: crate::llm::ChatContent::text(msg.content.clone()),
        });
    }
    if let Some(attachment_message) = build_llm_attachment_message(&attachments)? {
        llm_messages.push(attachment_message);
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
        model_override: thread.llm_model.clone().filter(|m| !m.trim().is_empty()),
        session_key: Some(thread_session_key(&thread.id)),
    };

    let resp = {
        let ai_ctx = state.ai_ctx.read().await;
        // Prefer the thread's pinned provider when available.
        if let Some(provider) = ai_ctx.llm.provider(&thread.provider_id) {
            provider.chat(llm_req).await.map_err(|e| e.to_string())?
        } else if ai_ctx.llm.needs_vault_unlock(&thread.provider_id) {
            // Pinned provider is blocked on a locked vault. Fail closed with
            // a VAULT_LOCKED error so the frontend can prompt for unlock
            // instead of routing the request through some other provider the
            // user did not intend to use.
            return Err(format!(
                "VAULT_LOCKED: provider '{}' needs the vault unlocked to load its API key",
                thread.provider_id
            ));
        } else if let Some(group_id) = provider_group_id_from_route(&thread.provider_id) {
            return Err(format!(
                "Provider group '{group_id}' has no available chat providers."
            ));
        } else {
            // Fall back to the task-routed provider with timeout/fallback.
            ai_ctx
                .llm
                .complete(llm_req, TaskKind::ChatDrawer)
                .await
                .map_err(|e| e.to_string())?
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
        attachments,
    };
    let assistant_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: resp.content,
        created_at: ts + 1,
        redacted: false,
        attachments: Vec::new(),
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

    Ok(ChatSendResponse {
        user_message: user_msg,
        assistant_message: assistant_msg,
        redacted_count,
    })
}
