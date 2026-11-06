use super::*;

/// Resolve the effective output format for a thread, falling back to the
/// global default. Returns one of "md" | "html" | "plain".
pub(super) fn resolve_output_format(thread: &store::ChatThread, config: &AiConfig) -> String {
    let candidate = thread
        .output_format
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| config.chat_output_format.clone());
    match candidate.as_str() {
        "md" | "html" | "plain" => candidate,
        _ => "md".into(),
    }
}

/// Build the assistant system prompt. The base prompt explains the role; an
/// extra paragraph instructs the assistant to format its replies as Markdown,
/// raw HTML, or plain text — matching what the renderer is expecting.
pub(super) fn build_system_prompt(format: &str) -> String {
    let base = "You are the AI assistant inside the Taomni terminal manager. \
                Help the user manage SSH sessions, analyse terminal output, and craft shell commands. \
                Reply in the same language the user writes in (default Chinese), and stay concise.";
    let format_clause = match format {
        "html" => {
            "Render your reply as a self-contained HTML fragment. \
                   Use semantic tags such as <p>, <ul>/<ol>, <li>, <h2>/<h3>, <code>, and <pre><code class=\"language-…\"> for code blocks. \
                   Do NOT wrap the answer in <html>, <body>, <head>, <script>, <style>, or include event handlers — the host sanitises everything else."
        }
        "plain" => {
            "Reply in plain text only — no Markdown syntax, no HTML tags. \
                    Keep paragraphs short and use blank lines for separation."
        }
        // "md" is the default.
        _ => {
            "Format your reply as GitHub-flavoured Markdown. \
              Use ```language fenced blocks for code, `inline code` for symbols/commands, \
              tables / bullet lists / headings (##, ###) when they help readability. \
              Do NOT wrap the entire answer in a single fenced block."
        }
    };
    format!("{}\n\n{}", base, format_clause)
}

/// Create a new chat thread.
#[tauri::command]
pub async fn chat_new_thread(
    provider_id: Option<String>,
    linked_session_id: Option<String>,
    mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<store::ChatThread, String> {
    let config = AiConfig::load(&default_ai_config_path());
    let pid = provider_id.unwrap_or_else(|| config.llm.active.clone());
    let mode = normalize_thread_mode(mode)?;
    let thread = store::ChatThread {
        id: Uuid::new_v4().to_string(),
        title: "New chat".into(),
        provider_id: pid,
        created_at: now(),
        updated_at: now(),
        linked_session_id,
        source: "drawer".into(),
        mode,
        cc_session_id: None,
        acp_session_id: None,
        // New threads inherit the global default; the user can override per-thread later.
        output_format: None,
        cc_model: None,
        llm_model: None,
    };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::create_thread(&db, &thread).map_err(|e| e.to_string())?;
    state.mobile.events.publish(serde_json::json!({"type":"session_changed","session_id":format!("thread:{}", thread.id),"change_kind":"opened"}));
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::delete_thread(&db, &thread_id).map_err(|e| e.to_string())?;
    }
    stop_thread_runtime(&thread_id, &app, state.inner()).await;
    state.mobile.file_roots.lock().unwrap().remove(&thread_id);
    state.mobile.roots_changed.notify_one();
    state
        .mobile
        .task_summaries
        .lock()
        .unwrap()
        .remove(&thread_id);
    state.mobile.events.publish(serde_json::json!({"type":"session_changed","session_id":format!("thread:{thread_id}"),"change_kind":"deleted"}));
    Ok(())
}

/// Change the provider (LLM) bound to an existing thread. Subsequent
/// chat_send / chat_stream calls on this thread will use the new provider.
#[tauri::command]
pub async fn chat_set_thread_provider(
    thread_id: String,
    provider_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::update_thread_provider(&db, &thread_id, &provider_id).map_err(|e| e.to_string())?;
    }
    // Switching away from a local agent provider orphans its per-thread child;
    // recycle so we don't leak the process / MCP token / temp dir.
    if provider_id != "claude-code" {
        crate::agent::cc_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    }
    if provider_id != "codex" {
        crate::agent::codex_bridge::commands::recycle_thread_process(state.inner(), &thread_id)
            .await;
    }
    acp::recycle_if_profile_changed(state.inner(), &thread_id, &provider_id).await;
    acp::recycle_media_process(state.inner(), &app, &thread_id).await;
    Ok(())
}

/// Set or clear the per-thread Claude Code model override. Pass `None`/empty
/// to inherit `cc_bridge.default_model`. The model
/// is a spawn-time `--model` arg the live process can't adopt, so we recycle
/// the thread's CC process — the next message respawns it with the new model.
#[tauri::command]
pub async fn chat_set_thread_cc_model(
    thread_id: String,
    model: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::update_thread_cc_model(&db, &thread_id, model.as_deref())
            .map_err(|e| e.to_string())?;
    }
    crate::agent::cc_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    crate::agent::codex_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    Ok(())
}

pub fn thread_session_key(thread_id: &str) -> String {
    crate::llm::opencode_go::catalog::session_key(thread_id)
}

#[tauri::command]
pub async fn chat_set_thread_llm_model(
    thread_id: String,
    model: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::update_thread_llm_model(&db, &thread_id, model.as_deref()).map_err(|e| e.to_string())
}

/// Set or clear the per-thread output-format override ("md" | "html" | "plain").
/// Pass `None` (or an empty string) to clear and inherit `AiConfig.chat_output_format`.
#[tauri::command]
pub async fn chat_set_thread_output_format(
    thread_id: String,
    output_format: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let normalized = output_format
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    if let Some(fmt) = normalized {
        if !matches!(fmt, "md" | "html" | "plain") {
            return Err(format!(
                "Invalid output_format '{}': expected 'md', 'html', or 'plain'.",
                fmt
            ));
        }
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::update_thread_output_format(&db, &thread_id, normalized).map_err(|e| e.to_string())
}

/// Sweep retention: delete threads older than `keep_days`. Returns the number
/// of threads deleted. Frontend invokes this at startup and on a 24h timer.
#[tauri::command]
pub async fn chat_purge_old(keep_days: u32, state: State<'_, AppState>) -> Result<usize, String> {
    let cutoff = chrono::Utc::now().timestamp() - (keep_days as i64) * 86_400;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::delete_threads_older_than(&db, cutoff).map_err(|e| e.to_string())
}

/// Export every thread + message into a single JSON file at `out_path`.
/// We write JSON (not zip) for portability — the user can compress externally.
/// Sensitive content already passed through `redact::redact` before persistence.
#[tauri::command]
pub async fn chat_export_archive(
    out_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    use serde_json::json;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let threads = store::list_threads(&db, 100_000).map_err(|e| e.to_string())?;
    let mut total = 0;
    let mut payload = Vec::with_capacity(threads.len());
    for t in &threads {
        let messages = store::list_messages(&db, &t.id).map_err(|e| e.to_string())?;
        total += messages.len();
        payload.push(json!({
            "thread": t,
            "messages": messages,
        }));
    }
    let json_text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&out_path, json_text).map_err(|e| e.to_string())?;
    Ok(total)
}
