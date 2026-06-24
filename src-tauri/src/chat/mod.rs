pub mod inline_qq;
pub mod redact;
pub mod store;

use crate::ai::config::{default_ai_config_path, AiConfig};
use crate::llm::{ChatMessage as LlmMessage, ChatRequest, ChatStreamEvent, TaskKind};
use crate::state::AppState;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Resolve the effective output format for a thread, falling back to the
/// global default. Returns one of "md" | "html" | "plain".
fn resolve_output_format(thread: &store::ChatThread, config: &AiConfig) -> String {
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
fn build_system_prompt(format: &str) -> String {
    let base = "You are the AI assistant inside the Taomni terminal manager. \
                Help the user manage SSH sessions, analyse terminal output, and craft shell commands. \
                Reply in the same language the user writes in (default Chinese), and stay concise.";
    let format_clause = match format {
        "html" => "Render your reply as a self-contained HTML fragment. \
                   Use semantic tags such as <p>, <ul>/<ol>, <li>, <h2>/<h3>, <code>, and <pre><code class=\"language-…\"> for code blocks. \
                   Do NOT wrap the answer in <html>, <body>, <head>, <script>, <style>, or include event handlers — the host sanitises everything else.",
        "plain" => "Reply in plain text only — no Markdown syntax, no HTML tags. \
                    Keep paragraphs short and use blank lines for separation.",
        // "md" is the default.
        _ => "Format your reply as GitHub-flavoured Markdown. \
              Use ```language fenced blocks for code, `inline code` for symbols/commands, \
              tables / bullet lists / headings (##, ###) when they help readability. \
              Do NOT wrap the entire answer in a single fenced block.",
    };
    format!("{}\n\n{}", base, format_clause)
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
        title: "New chat".into(),
        provider_id: pid,
        created_at: now(),
        updated_at: now(),
        linked_session_id,
        source: "drawer".into(),
        cc_session_id: None,
        // New threads inherit the global default; the user can override per-thread later.
        output_format: None,
        cc_model: None,
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

/// Change the provider (LLM) bound to an existing thread. Subsequent
/// chat_send / chat_stream calls on this thread will use the new provider.
#[tauri::command]
pub async fn chat_set_thread_provider(
    thread_id: String,
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::update_thread_provider(&db, &thread_id, &provider_id).map_err(|e| e.to_string())?;
    }
    // Switching away from Claude Code orphans its per-thread child; recycle it
    // so we don't leak the process / MCP token / temp dir. (No-op if none.)
    if provider_id != "claude-code" {
        crate::agent::cc_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    }
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
    Ok(())
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

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatSendRequest {
    pub thread_id: String,
    pub content: String,
    /// Optional terminal content to attach as @terminal context.
    pub terminal_context: Option<String>,
    /// Phase 3.S — the `SessionConfig.id` of the saved session this CC thread
    /// is bound to, resolved by the frontend from the linked terminal tab's
    /// registry entry (`thread.linked_session_id` is a *tab* id, not a
    /// `SessionConfig.id`, so the backend cannot derive this on its own). Used
    /// to build the session-identity card injected into Claude Code. `None` for
    /// unbound / local / unsaved-tab threads.
    #[serde(default)]
    pub bound_session_id: Option<String>,
    /// Phase 3.3 — the bound terminal's live working directory (from the
    /// frontend's OSC-7 tracking). Unlike the session-identity card, cwd is
    /// volatile (the user `cd`s around), so it is injected *per turn* as a
    /// message prefix rather than baked into the spawn-time card. Informational
    /// only — it does not set the CC child's `current_dir` or grant `--add-dir`
    /// access (that is 3.2, deliberately out of scope). `None` when unknown.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Phase 6 — the live `db_connections` runtime id this CC thread is bound to,
    /// for SQL/Redis DB sessions. Like `cwd`, it is volatile (the frontend
    /// regenerates it on each (re)connect and the backend can't derive it), so
    /// it is bridged *per turn* and stored into `AppState.cc_db_bindings` so the
    /// DB MCP handlers can resolve their bound connection. `None` for non-DB
    /// threads or a DB tab that isn't connected.
    #[serde(default)]
    pub bound_db_connection_id: Option<String>,
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
        let thread = threads
            .into_iter()
            .find(|t| t.id == req.thread_id)
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };

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
        } else if ai_ctx.llm.needs_vault_unlock(&thread.provider_id) {
            // Pinned provider is blocked on a locked vault. Fail closed with
            // a VAULT_LOCKED error so the frontend can prompt for unlock
            // instead of routing the request through some other provider the
            // user did not intend to use.
            return Err(format!(
                "VAULT_LOCKED: provider '{}' needs the vault unlocked to load its API key",
                thread.provider_id
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

    Ok(ChatSendResponse {
        user_message: user_msg,
        assistant_message: assistant_msg,
        redacted_count,
    })
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEventOut {
    /// User message persisted; frontend can render it immediately.
    UserMessage { message: store::ChatMessage },
    /// Assistant message id allocated; tokens will follow under this id.
    AssistantStart {
        id: String,
        thread_id: String,
        created_at: i64,
    },
    /// One token (or token group) of the assistant response.
    Token { id: String, content: String },
    /// Stream ended cleanly; assistant message persisted.
    End {
        id: String,
        thread_id: String,
        content: String,
        redacted_count: usize,
    },
    /// Stream ended with an error (assistant message NOT persisted).
    Error { id: String, message: String },
    /// Claude Code tool activity for live, display-only cards (3.5). Carries NO
    /// re-executable payload — confirmation already happened via the MCP
    /// permission prompt; this is purely for rendering. The persisted message
    /// still contains the compact text transcript line (history durability), so
    /// the frontend shows these cards only while the message is streaming.
    CcToolActivity {
        /// Assistant message id these cards group under.
        id: String,
        /// CC tool_use id, pairing a "use" with its later "result".
        call_id: String,
        /// "use" | "result".
        phase: String,
        tool: String,
        detail: String,
    },
    /// Claude Code token/cost/timing rollup for the assistant message footer
    /// (3.5). Live-only (not persisted), emitted once on the final result.
    Usage {
        id: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    },
}

/// The one-line argument summary for a CC tool call ("ls -la", "/tmp/x.rs", …).
fn cc_tool_arg_summary(input: &serde_json::Value) -> Option<&str> {
    input
        .get("command")
        .and_then(|v| v.as_str())
        .or_else(|| input.get("file_path").and_then(|v| v.as_str()))
        .or_else(|| input.get("notebook_path").and_then(|v| v.as_str()))
        .or_else(|| input.get("path").and_then(|v| v.as_str()))
}

/// Render a CC tool-use event as a compact, human-readable transcript line.
///
/// This is *not* a `[TOOL_CALL]` marker — it carries no machine-parseable JSON,
/// so MessageBubble never turns it into an ActionCard or re-executes it. It
/// exists purely so the chat keeps a record of what Claude Code did (the real
/// confirmation happens live via the in-app MCP server's permission prompt).
fn format_cc_tool_use(name: &str, input: &serde_json::Value) -> String {
    match cc_tool_arg_summary(input) {
        Some(s) => format!("\n> 🔧 `{}` — {}\n", name, s),
        None => format!("\n> 🔧 `{}`\n", name),
    }
}

/// A short, single-line preview of a CC tool result for the transcript /
/// display card (collapses whitespace, truncates).
fn cc_tool_result_preview(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 200 {
        let truncated: String = flat.chars().take(200).collect();
        format!("{truncated}…")
    } else {
        flat
    }
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
        let thread = threads
            .into_iter()
            .find(|t| t.id == req.thread_id)
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
    emit(&StreamEventOut::UserMessage {
        message: user_msg.clone(),
    });
    if thread.provider_id == "claude-code" {
        // Allocate the assistant message id and begin streaming.
        let assistant_id = Uuid::new_v4().to_string();
        let assistant_ts = now() + 1;
        emit(&StreamEventOut::AssistantStart {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            created_at: assistant_ts,
        });

        // 1. Verify Claude Code is enabled
        let ai_config = AiConfig::load(&default_ai_config_path());
        if !ai_config.cc_bridge.enabled || ai_config.fully_disabled || ai_config.full_local_mode {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message: "Claude Code is unavailable in full-local / fully-disabled mode or is disabled.".into(),
            });
            return Ok(());
        }

        // 2. Find Claude Code CLI binary path
        let binary = if ai_config.cc_bridge.binary == "auto" {
            crate::agent::cc_bridge::find_claude_binary().ok_or("Claude Code CLI not found")?
        } else {
            ai_config.cc_bridge.binary.clone()
        };

        // 3. Resolve session id for --resume continuity.
        let resume_session = thread.cc_session_id.clone();

        // 4. Get or create the per-thread CC process. Only a *new* process
        //    materialises temp config files — a reused process keeps the
        //    obscure settings file it was launched with (and which is scrubbed
        //    when the session stops).
        let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
        let process = match existing {
            Some(p) => p,
            None => {
                // Phase 6 — pick the MCP flavor from the bound session's type so
                // the thread loads *only* the right tool surface: a SQL DB
                // session (MySQL/PG/SQL Server/ClickHouse/Presto) gets the SQL tools, Redis
                // gets the Redis tools, everything else (SSH/local/unbound) gets
                // the shell tools. Resolve in a tight scope so the db lock is
                // dropped before the async provision call.
                let flavor = {
                    use crate::agent::cc_bridge::mcp_http::Flavor;
                    let session_type = req
                        .bound_session_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .and_then(|sid| {
                            let db = state.db.lock().ok()?;
                            crate::session::db::get_session(&db, sid).ok()
                        })
                        .map(|sc| sc.session_type);
                    Flavor::for_session_type(session_type.as_ref())
                };

                // Provision the in-app rmcp MCP server + a per-thread scoped
                // token (trust inferred from whether the thread is linked to a
                // remote session). Injected into the thread's .mcp.json.
                let (cc_server_url, cc_token) =
                    match crate::agent::cc_bridge::mcp_http::provision_for_thread(
                        &app,
                        &req.thread_id,
                        thread.linked_session_id.clone(),
                        req.bound_session_id.clone(),
                        flavor,
                        ai_config.cc_bridge.confirm_readonly,
                    )
                    .await
                    {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                // Resolve the user's custom settings.json from the vault (when
                // configured). A locked vault means we can't read the token, so
                // surface it as a stream error and let the UI prompt to unlock.
                let custom = match crate::agent::cc_bridge::config::resolve_custom_settings(
                    &ai_config.cc_bridge,
                    &state.vault,
                ) {
                    Ok(c) => c,
                    Err(e) => {
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };
                let files = match crate::agent::cc_bridge::config::create_session_files(
                    custom.as_deref(),
                    flavor.server_name(),
                    &cc_server_url,
                    &cc_token,
                ) {
                    Ok(f) => f,
                    Err(e) => {
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };

                // Phase 3.S — assemble the session-identity card so CC knows
                // which saved session this thread is bound to, then inject it
                // as CC's appended system prompt. Written into the process temp
                // dir (scrubbed on stop/drop) and passed via the *file* flag so
                // the bound host/user never appear in argv (which other local
                // users can read via `ps`).
                let session_card = {
                    let db = state.db.lock().map_err(|e| e.to_string())?;
                    let session = req
                        .bound_session_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .and_then(|sid| crate::session::db::get_session(&db, sid).ok());
                    let recent = session
                        .as_ref()
                        .map(|sc| {
                            crate::history::db_list_recent(
                                &db,
                                &crate::agent::cc_bridge::session_card::host_key_for(sc),
                                crate::agent::cc_bridge::session_card::HISTORY_LIMIT,
                            )
                            .unwrap_or_default()
                        })
                        .unwrap_or_default();
                    let raw = crate::agent::cc_bridge::session_card::render_card(
                        session.as_ref(),
                        &req.thread_id,
                        thread.linked_session_id.is_some(),
                        &recent,
                    );
                    redact::redact(&raw).0
                };
                let card_path = files.dir.join("system-prompt.txt");
                let card_file: Option<String> = match std::fs::write(&card_path, &session_card) {
                    Ok(()) => Some(card_path.to_string_lossy().to_string()),
                    Err(e) => {
                        eprintln!("[cc] session card write failed, continuing without it: {e}");
                        None
                    }
                };

                // Build extra args. The model is per-thread (3.4) when set,
                // else the configured default. Baked into argv at spawn, so a
                // model change recycles the process (chat_set_thread_cc_model).
                let model = thread
                    .cc_model
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or_else(|| ai_config.cc_bridge.default_model.clone());
                let mut extra_args = vec![
                    "--model".into(),
                    model,
                    "--max-turns".into(),
                    ai_config.cc_bridge.max_turns.to_string(),
                    "--settings".into(),
                    files.settings_path.to_string_lossy().to_string(),
                    "--mcp-config".into(),
                    files.mcp_path.to_string_lossy().to_string(),
                    // Use *only* our MCP config; ignore any user ~/.claude MCP
                    // that could bypass the permission pipeline.
                    "--strict-mcp-config".into(),
                    "--permission-prompt-tool".into(),
                    flavor.permission_prompt_tool().into(),
                ];
                // Phase 3.S — inject the session-identity card (file variant
                // keeps host/user out of argv).
                if let Some(path) = card_file {
                    extra_args.push("--append-system-prompt-file".into());
                    extra_args.push(path);
                }
                if let Some(sid) = &resume_session {
                    extra_args.push("--resume".into());
                    extra_args.push(sid.clone());
                }

                let p = std::sync::Arc::new(
                    crate::agent::cc_bridge::process::CcProcess::new(
                        &binary,
                        extra_args,
                        Some(files.dir),
                    )
                    .with_token(cc_token.clone()),
                );
                // Re-check under the lock in case a concurrent send for the
                // same thread created one first; if so, our `p` is dropped and
                // its temp dir cleaned by the Drop impl.
                let mut registry = state.cc_processes.lock().await;
                match registry.get(&req.thread_id) {
                    Some(existing) => existing.clone(),
                    None => {
                        registry.insert(req.thread_id.clone(), p.clone());
                        p
                    }
                }
            }
        };

        // Start the liveness watchdog on the chosen Arc (idempotent). It holds
        // only a Weak<CcProcess>, so it exits cleanly once the registry drops
        // the process (provider switch / model change → recycle_thread_process).
        process.start_watchdog();

        // 7. Run process with callback to stream
        let assistant_id_clone = assistant_id.clone();
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        // Stash the live cwd for this thread so backend-side tools invoked
        // mid-turn (run_captured → B executor) can bridge it (`cd <cwd> && …`);
        // an MCP tool call has no per-turn cwd of its own. Volatile, so refresh
        // every turn.
        if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            state
                .cc_thread_cwd
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), cwd.to_string());
        }

        // Phase 6 — stash the live DB connection id this thread is bound to so
        // the SQL/Redis MCP handlers can resolve their target connection (the
        // runtime `db_connections` key is frontend-generated and not derivable
        // here). Volatile (regenerated on reconnect), so refreshed every turn;
        // cleared when absent so a stale, disconnected id never lingers.
        {
            let conn = req
                .bound_db_connection_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let mut bindings = state.cc_db_bindings.write().await;
            match conn {
                Some(c) => {
                    bindings.insert(req.thread_id.clone(), c.to_string());
                }
                None => {
                    bindings.remove(&req.thread_id);
                }
            }
        }

        // Build the per-turn context prefix CC sees: the live working
        // directory (3.3 — volatile, so injected each turn rather than in the
        // spawn-time identity card) followed by any attached terminal context,
        // mirroring how the native LLM path injects context as a leading user
        // turn. Both are redacted. Without this the CC branch silently dropped
        // fields the frontend already sends.
        let cc_message = {
            let mut prefix = String::new();
            if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let (clean_cwd, _) = redact::redact(cwd);
                prefix.push_str(&format!("当前工作目录：{}\n\n", clean_cwd));
            }
            if let Some(ctx) = req
                .terminal_context
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                let (clean_ctx, _) = redact::redact(ctx);
                prefix.push_str(&format!("[Terminal context]\n```\n{}\n```\n\n", clean_ctx));
            }
            format!("{}{}", prefix, clean_content)
        };
        let events = process.send_with_callback(&cc_message, move |evt| {
            use crate::agent::cc_bridge::protocol::CcEvent;
            match evt {
                CcEvent::Partial { content } => {
                    let _ = app_clone.emit(&event_name_clone, StreamEventOut::Token {
                        id: assistant_id_clone.clone(),
                        content: content.clone(),
                    });
                }
                // 3.5 — emit a structured, display-only card for tool use. It
                // carries no machine-parseable payload, so the frontend never
                // re-executes it (confirmation already happened live via the
                // MCP permission prompt). The compact text record is persisted
                // separately below, so reload still shows the activity as text.
                CcEvent::ToolUse { id, name, input } => {
                    let _ = app_clone.emit(&event_name_clone, StreamEventOut::CcToolActivity {
                        id: assistant_id_clone.clone(),
                        call_id: id.clone(),
                        phase: "use".into(),
                        tool: name.clone(),
                        detail: cc_tool_arg_summary(input).unwrap_or("").to_string(),
                    });
                }
                CcEvent::ToolResult { tool_use_id, content } => {
                    let _ = app_clone.emit(&event_name_clone, StreamEventOut::CcToolActivity {
                        id: assistant_id_clone.clone(),
                        call_id: tool_use_id.clone(),
                        phase: "result".into(),
                        tool: String::new(),
                        detail: cc_tool_result_preview(content),
                    });
                }
                CcEvent::Done { usage: Some(u) } => {
                    let _ = app_clone.emit(&event_name_clone, StreamEventOut::Usage {
                        id: assistant_id_clone.clone(),
                        input_tokens: u.input_tokens,
                        output_tokens: u.output_tokens,
                        cost_usd: u.total_cost_usd,
                        duration_ms: u.duration_ms,
                    });
                }
                _ => {}
            }
        }).await;

        let events = match events {
            Ok(ev) => ev,
            Err(e) => {
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message: e,
                });
                return Ok(());
            }
        };

        // 8. Extract final answer and persist. The persisted content keeps a
        // compact *text* transcript of tool activity (history durability); the
        // live structured cards (above) are ephemeral, so on reload the message
        // still shows what CC did, as text.
        let mut final_content = String::new();
        for event in &events {
            use crate::agent::cc_bridge::protocol::CcEvent;
            match event {
                CcEvent::AssistantMessage { content } => {
                    final_content.push_str(content);
                }
                CcEvent::ToolUse { name, input, .. } => {
                    final_content.push_str(&format_cc_tool_use(name, input));
                }
                CcEvent::ToolResult { content, .. } => {
                    let preview = cc_tool_result_preview(content);
                    if !preview.is_empty() {
                        final_content.push_str(&format!("> ↳ {}\n", preview));
                    }
                }
                _ => {}
            }
        }

        let session_id = crate::agent::cc_bridge::protocol::extract_session_id(&events).or(resume_session);
        if let Some(sid) = &session_id {
            if let Ok(db) = state.db.lock() {
                let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
            }
        }

        let assistant_msg = store::ChatMessage {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            role: "assistant".into(),
            content: final_content.clone(),
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
            content: final_content,
            redacted_count,
        });

        return Ok(());
    }

    // Build the LLM request.
    let ai_config = AiConfig::load(&default_ai_config_path());
    let output_format = resolve_output_format(&thread, &ai_config);
    let system_prompt = build_system_prompt(&output_format);
    let mut llm_messages: Vec<LlmMessage> = vec![LlmMessage::system(system_prompt)];
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
    for msg in &history {
        llm_messages.push(LlmMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
        });
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
        let pinned = ai_ctx.llm.provider(&thread.provider_id);
        let pinned_blocked = pinned.is_none() && ai_ctx.llm.needs_vault_unlock(&thread.provider_id);

        let provider = pinned.or_else(|| {
            // Don't fall back when the pinned provider is just locked — the
            // user wants that specific provider, and we should prompt for
            // unlock rather than silently rerouting.
            if pinned_blocked {
                None
            } else {
                ai_ctx
                    .llm
                    .provider(&ai_ctx.llm.provider_for_task(TaskKind::ChatDrawer))
            }
        });
        match provider {
            Some(p) => p.chat_stream(llm_req).await,
            None => {
                if pinned_blocked {
                    Err(crate::llm::LlmError::VaultLocked {
                        provider: thread.provider_id.clone(),
                    })
                } else {
                    Err(crate::llm::LlmError::Provider {
                        status: 0,
                        message: "No provider available".into(),
                    })
                }
            }
        }
    };

    let mut stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message: e.to_string(),
            });
            return Ok(());
        }
    };

    let mut accumulated = String::new();
    while let Some(evt) = stream.next().await {
        match evt {
            Ok(ChatStreamEvent::Token { content }) => {
                accumulated.push_str(&content);
                emit(&StreamEventOut::Token {
                    id: assistant_id.clone(),
                    content,
                });
            }
            Ok(ChatStreamEvent::End { .. }) => break,
            Ok(ChatStreamEvent::Error { message }) => {
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message,
                });
                return Ok(());
            }
            Err(e) => {
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message: e.to_string(),
                });
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

#[cfg(test)]
mod cc_tool_use_tests {
    use super::format_cc_tool_use;
    use serde_json::json;

    #[test]
    fn renders_command_without_tool_call_marker() {
        let line = format_cc_tool_use("run_in_terminal", &json!({ "command": "ls -la" }));
        assert!(line.contains("run_in_terminal"));
        assert!(line.contains("ls -la"));
        // Must NOT be a parseable marker (would trigger native re-execution).
        assert!(!line.contains("[TOOL_CALL]"));
    }

    #[test]
    fn renders_file_path_and_bare_tool() {
        let edit = format_cc_tool_use("Edit", &json!({ "file_path": "/tmp/x.rs" }));
        assert!(edit.contains("/tmp/x.rs"));
        assert!(!edit.contains("[TOOL_CALL]"));
        let bare = format_cc_tool_use("list_sessions", &json!({}));
        assert!(bare.contains("list_sessions"));
        assert!(!bare.contains("[TOOL_CALL]"));
    }
}
