use super::claude_code::stream_claude_code;
use super::codex::stream_codex;
use super::model::StreamTurn;
use super::provider::stream_provider;
use crate::chat::ChatSendRequest;
use crate::chat::StreamEventOut;
use crate::chat::acp;
use crate::chat::attachments;
use crate::chat::attachments::validate_chat_attachments;
use crate::chat::context;
use crate::chat::now;
use crate::chat::redact;
use crate::chat::store;
use crate::chat::stream;
use crate::state::AppState;
use futures::StreamExt;
use std::io::Read;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;
use uuid::Uuid;

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
    let attachments = validate_chat_attachments(&req.attachments)?;

    // Load thread + history.
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
        attachments: attachments.clone(),
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
    }
    emit(&StreamEventOut::UserMessage {
        message: user_msg.clone(),
    });

    let agent_ctx = crate::agent::context::build_agent_thread_context(
        state.inner(),
        crate::agent::context::AgentThreadContextInput {
            thread_id: req.thread_id.clone(),
            linked_session_id: thread.linked_session_id.clone(),
            bound_session_id: req.bound_session_id.clone(),
            cwd: req.cwd.clone(),
            local_terminal_env: req.local_terminal_env.clone(),
            bound_db_connection_id: req.bound_db_connection_id.clone(),
            bound_db_selected_objects: req.bound_db_selected_objects.clone(),
            bound_db_selected_table: req.bound_db_selected_table.clone(),
            code_workspace: req.code_workspace.clone(),
        },
    )?;

    if crate::agent::acp_bridge::profile_id_from_provider_id(&thread.provider_id).is_some() {
        return acp::stream(
            &req,
            &app,
            state.inner(),
            &event_name,
            &thread,
            &history,
            &attachments,
            &clean_content,
            redacted_count,
            &agent_ctx,
        )
        .await;
    }

    let turn = StreamTurn {
        req,
        app,
        state,
        event_name,
        thread,
        history,
        attachments,
        clean_content,
        redacted_count,
        user_msg,
        agent_ctx,
    };
    match turn.thread.provider_id.as_str() {
        "claude-code" => stream_claude_code(turn).await,
        "codex" => stream_codex(turn).await,
        _ => stream_provider(turn).await,
    }
}
