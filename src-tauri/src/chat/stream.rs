use super::*;

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

pub(super) fn llm_tools_from_mcp(tools: Vec<rmcp::model::Tool>) -> Vec<ChatTool> {
    tools
        .into_iter()
        .map(|tool| ChatTool {
            name: tool.name.to_string(),
            description: tool.description.map(|description| description.to_string()),
            input_schema: serde_json::Value::Object(tool.input_schema.as_ref().clone()),
        })
        .collect()
}

pub(super) fn assistant_tool_message(content: &str, tool_calls: &[ChatToolCall]) -> LlmMessage {
    let mut parts = Vec::new();
    if !content.is_empty() {
        parts.push(ChatContentPart::Text {
            text: content.to_string(),
        });
    }
    parts.extend(tool_calls.iter().map(|call| ChatContentPart::ToolUse {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
    }));
    LlmMessage {
        role: "assistant".into(),
        content: crate::llm::ChatContent::Parts(parts),
    }
}

#[tauri::command]
pub async fn chat_stop_stream(
    thread_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    stop_thread_runtime(&thread_id, &app, state.inner()).await;
    Ok(())
}

/// Stop every process and pending native permission tied to one thread. This
/// is used both for an explicit Stop action and when deleting a thread so an
/// already-visible confirmation card cannot approve work for a removed chat.
pub(super) async fn stop_thread_runtime(thread_id: &str, app: &AppHandle, state: &AppState) {
    // Stop the in-flight turn regardless of provider/runtime. Claude Code also
    // and Codex keep persistent per-thread process registries for reuse; remove
    // those entries on explicit stop so the next turn starts from clean bridge
    // processes.
    let run = { state.agent.chat_runs.lock().await.remove(thread_id) };
    let cc_process = { state.agent.cc_processes.lock().await.remove(thread_id) };
    let codex_process = { state.agent.codex_processes.lock().await.remove(thread_id) };
    let acp_process = { state.agent.acp_processes.lock().await.remove(thread_id) };
    let acp_media_process = {
        state
            .agent
            .acp_media_processes
            .lock()
            .await
            .remove(thread_id)
    };

    if let Some(run) = run {
        run.stop().await;
    }
    if let Some(process) = cc_process {
        if !process.is_stopped() {
            process.stop().await;
        }
    }
    if let Some(process) = codex_process {
        process.stop().await;
    }
    if let Some(process) = acp_process {
        process.stop().await;
    }
    if let Some(process) = acp_media_process {
        process.stop().await;
    }
    // Clear a visible native-tool gate immediately even when its subprocess
    // has just been stopped and cannot deliver its own runtime event.
    let _ = app.emit(
        "agent-acp-permission-dismissed",
        json!({ "threadId": thread_id, "permissionOwnerId": null, "callId": null }),
    );
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
                message:
                    "Claude Code is unavailable in full-local / fully-disabled mode or is disabled."
                        .into(),
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
        let existing = {
            state
                .agent
                .cc_processes
                .lock()
                .await
                .get(&req.thread_id)
                .cloned()
        };
        let process = match existing {
            Some(p) => p,
            None => {
                let effective_proxy =
                    match crate::agent::cc_bridge::config::resolve_effective_proxy_url(
                        state.inner(),
                        &ai_config.cc_bridge,
                    ) {
                        Ok(proxy) => proxy,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                // Phase 6 — pick the MCP flavor from the shared agent context so
                // the thread loads only the right tool surface: SQL, Redis, or shell.
                let flavor = agent_ctx.flavor;

                // Provision the in-app rmcp MCP server + a per-thread scoped
                // token (trust inferred from whether the thread is linked to a
                // remote session). Injected into the thread's .mcp.json.
                let (cc_server_url, cc_token) =
                    match crate::agent::cc_bridge::mcp_http::provision_for_thread(
                        &app,
                        &req.thread_id,
                        agent_ctx.linked_session_id.clone(),
                        agent_ctx.bound_session_id.clone(),
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
                let control_server_url =
                    match crate::agent::cc_bridge::mcp_http::control_server_url() {
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
                    &control_server_url,
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
                let session_card = agent_ctx.session_card.clone();
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
                    .with_proxy_url(effective_proxy)
                    .with_token(cc_token.clone()),
                );
                // Re-check under the lock in case a concurrent send for the
                // same thread created one first; if so, our `p` is dropped and
                // its temp dir cleaned by the Drop impl.
                let mut registry = state.agent.cc_processes.lock().await;
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
        state.agent.chat_runs.lock().await.insert(
            req.thread_id.clone(),
            run::ChatRunHandle::bridge_process("claude-code", process.clone()),
        );

        // 7. Run process with callback to stream
        let assistant_id_clone = assistant_id.clone();
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        // Refresh volatile per-turn bindings for backend-side tools: cwd for
        // run_captured and DB connection id for SQL/Redis MCP handlers.
        agent_ctx.refresh_runtime_bindings(state.inner()).await;

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
            if let Some(block) = code_workspace_context_block(&agent_ctx) {
                let (clean_block, _) = redact::redact(block.trim_end());
                prefix.push_str(&format!("{clean_block}\n\n"));
            }
            if let Some(line) = selected_objects_context_line(&agent_ctx) {
                let (clean_line, _) = redact::redact(line.trim_end());
                prefix.push_str(&format!("{clean_line}\n\n"));
            }
            if let Some(ctx) = req
                .terminal_context
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                let (clean_ctx, _) = redact::redact(ctx);
                prefix.push_str(&format!("[Terminal context]\n```\n{}\n```\n\n", clean_ctx));
            }
            prefix.push_str(&render_agent_attachment_prefix(&attachments));
            format!("{}{}", prefix, clean_content)
        };
        let events = process
            .send_with_callback(&cc_message, move |evt| {
                use crate::agent::cc_bridge::protocol::CcEvent;
                match evt {
                    CcEvent::Partial { content } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::Token {
                                id: assistant_id_clone.clone(),
                                content: content.clone(),
                            },
                        );
                    }
                    // 3.5 — emit a structured, display-only card for tool use. It
                    // carries no machine-parseable payload, so the frontend never
                    // re-executes it (confirmation already happened live via the
                    // MCP permission prompt). The compact text record is persisted
                    // separately below, so reload still shows the activity as text.
                    CcEvent::ToolUse { id, name, input } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::CcToolActivity {
                                id: assistant_id_clone.clone(),
                                call_id: id.clone(),
                                phase: "use".into(),
                                tool: name.clone(),
                                detail: cc_tool_arg_summary(input).unwrap_or_default(),
                            },
                        );
                    }
                    CcEvent::ToolResult {
                        tool_use_id,
                        content,
                    } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::CcToolActivity {
                                id: assistant_id_clone.clone(),
                                call_id: tool_use_id.clone(),
                                phase: "result".into(),
                                tool: String::new(),
                                detail: cc_tool_result_preview(content),
                            },
                        );
                    }
                    CcEvent::Done { usage: Some(u) } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::Usage {
                                id: assistant_id_clone.clone(),
                                input_tokens: u.input_tokens,
                                output_tokens: u.output_tokens,
                                cost_usd: u.total_cost_usd,
                                duration_ms: u.duration_ms,
                            },
                        );
                    }
                    _ => {}
                }
            })
            .await;
        state.agent.chat_runs.lock().await.remove(&req.thread_id);

        let events = match events {
            Ok(ev) => ev,
            Err(e) => {
                let msg = if process.is_stopped() {
                    "Stream stopped by user".to_string()
                } else {
                    e
                };
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message: msg,
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

        let session_id =
            crate::agent::cc_bridge::protocol::extract_session_id(&events).or(resume_session);
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
            attachments: Vec::new(),
        };

        let is_first = history.is_empty();
        {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
            if is_first {
                let title = user_msg.content.chars().take(40).collect::<String>();
                store::update_thread_title(&db, &req.thread_id, &title)
                    .map_err(|e| e.to_string())?;
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

    if thread.provider_id == "codex" {
        let assistant_id = Uuid::new_v4().to_string();
        let assistant_ts = now() + 1;
        emit(&StreamEventOut::AssistantStart {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            created_at: assistant_ts,
        });

        let ai_config = AiConfig::load(&default_ai_config_path());
        if !ai_config.codex_bridge.enabled || ai_config.fully_disabled || ai_config.full_local_mode
        {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message: "Codex is unavailable in full-local / fully-disabled mode or is disabled."
                    .into(),
            });
            return Ok(());
        }

        let binary = if ai_config.codex_bridge.binary == "auto" {
            crate::agent::codex_bridge::find_codex_binary().ok_or("Codex CLI not found")?
        } else {
            ai_config.codex_bridge.binary.clone()
        };
        let resume_session = thread.cc_session_id.clone();
        let runtime = match crate::agent::codex_bridge::config::resolve_custom_runtime(
            &ai_config.codex_bridge,
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

        let existing = {
            state
                .agent
                .codex_processes
                .lock()
                .await
                .get(&req.thread_id)
                .cloned()
        };
        let process = match existing {
            Some(p) => p,
            None => {
                let flavor = agent_ctx.flavor;

                let (server_url, token) =
                    match crate::agent::cc_bridge::mcp_http::provision_for_thread_with_inline_permission(
                        &app,
                        &req.thread_id,
                        agent_ctx.linked_session_id.clone(),
                        agent_ctx.bound_session_id.clone(),
                        flavor,
                        ai_config.codex_bridge.confirm_readonly,
                        true,
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
                let control_server_url =
                    match crate::agent::cc_bridge::mcp_http::control_server_url() {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };

                let thread_config =
                    crate::agent::codex_bridge::config::build_thread_config_from_config(
                        runtime.config.clone(),
                        flavor.server_name(),
                        &server_url,
                        &token,
                        &control_server_url,
                    );

                let output_format = resolve_output_format(&thread, &ai_config);
                let base_instructions = format!(
                    "{}\n\nYou are connected through Codex app-server inside Taomni. Use the domain Taomni MCP tools only for the bound terminal/database session described in the developer instructions. The separate taomni_control MCP server is the UI/session/tab control plane: when the user asks to open or switch to a saved Taomni session, open the session editor, or manage tabs, call taomni_control tools instead of telling the user to do it manually.",
                    build_system_prompt(&output_format)
                );
                let developer_instructions = agent_ctx.session_card.clone();

                let temp_dir =
                    std::env::temp_dir().join(format!(".{}", uuid::Uuid::new_v4().simple()));
                if let Err(e) = std::fs::create_dir_all(&temp_dir) {
                    crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                    emit(&StreamEventOut::Error {
                        id: assistant_id.clone(),
                        message: format!("Failed to create Codex temp dir: {e}"),
                    });
                    return Ok(());
                }

                let model = thread
                    .cc_model
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .or_else(|| {
                        if runtime.config.contains_key("model") {
                            None
                        } else {
                            Some(ai_config.codex_bridge.default_model.clone())
                        }
                    });
                let effective_proxy =
                    match crate::agent::codex_bridge::config::resolve_effective_proxy_url(
                        state.inner(),
                        &ai_config.codex_bridge,
                    ) {
                        Ok(proxy) => proxy,
                        Err(e) => {
                            crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                            let _ = std::fs::remove_dir_all(&temp_dir);
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                let p = match crate::agent::codex_bridge::process::CodexAppServer::spawn(
                    &binary,
                    effective_proxy,
                    Some(temp_dir.clone()),
                    Some(token.clone()),
                    Some(runtime.env.clone()),
                    runtime.isolated_home,
                )
                .await
                {
                    Ok(p) => std::sync::Arc::new(p),
                    Err(e) => {
                        crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                        let _ = std::fs::remove_dir_all(&temp_dir);
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };

                if let Err(e) = p
                    .start_or_resume_thread(
                        crate::agent::codex_bridge::process::CodexThreadOptions {
                            resume_thread_id: resume_session.clone(),
                            model,
                            cwd: req.cwd.clone(),
                            approval_policy: ai_config.codex_bridge.approval_policy.clone(),
                            sandbox: ai_config.codex_bridge.sandbox.clone(),
                            network_access: ai_config.codex_bridge.network_access,
                            config: thread_config,
                            base_instructions: Some(base_instructions),
                            developer_instructions: Some(developer_instructions),
                            ephemeral: false,
                        },
                    )
                    .await
                {
                    emit(&StreamEventOut::Error {
                        id: assistant_id.clone(),
                        message: e,
                    });
                    p.stop().await;
                    return Ok(());
                }

                let mut registry = state.agent.codex_processes.lock().await;
                match registry.get(&req.thread_id) {
                    Some(existing) => existing.clone(),
                    None => {
                        registry.insert(req.thread_id.clone(), p.clone());
                        p
                    }
                }
            }
        };

        agent_ctx.refresh_runtime_bindings(state.inner()).await;

        let codex_message = {
            let mut prefix = String::new();
            if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let (clean_cwd, _) = redact::redact(cwd);
                prefix.push_str(&format!("当前工作目录：{}\n\n", clean_cwd));
            }
            if let Some(block) = code_workspace_context_block(&agent_ctx) {
                let (clean_block, _) = redact::redact(block.trim_end());
                prefix.push_str(&format!("{clean_block}\n\n"));
            }
            if let Some(line) = selected_objects_context_line(&agent_ctx) {
                let (clean_line, _) = redact::redact(line.trim_end());
                prefix.push_str(&format!("{clean_line}\n\n"));
            }
            if let Some(ctx) = req
                .terminal_context
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                let (clean_ctx, _) = redact::redact(ctx);
                prefix.push_str(&format!("[Terminal context]\n```\n{}\n```\n\n", clean_ctx));
            }
            prefix.push_str(&render_agent_attachment_prefix(&attachments));
            format!("{}{}", prefix, clean_content)
        };

        let assistant_id_clone = assistant_id.clone();
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        let model = thread
            .cc_model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .or_else(|| {
                if runtime.config.contains_key("model") {
                    None
                } else {
                    Some(ai_config.codex_bridge.default_model.clone())
                }
            });
        let events = process
            .send_turn_with_callback(
                &codex_message,
                crate::agent::codex_bridge::process::CodexTurnOptions {
                    cwd: req.cwd.clone(),
                    approval_policy: ai_config.codex_bridge.approval_policy.clone(),
                    sandbox: ai_config.codex_bridge.sandbox.clone(),
                    network_access: ai_config.codex_bridge.network_access,
                    model,
                },
                move |evt| {
                    use crate::agent::codex_bridge::protocol::CodexEvent;
                    match evt {
                        CodexEvent::Partial { content } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::Token {
                                    id: assistant_id_clone.clone(),
                                    content: content.clone(),
                                },
                            );
                        }
                        CodexEvent::ToolUse { id, name, input } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::CcToolActivity {
                                    id: assistant_id_clone.clone(),
                                    call_id: id.clone(),
                                    phase: "use".into(),
                                    tool: name.clone(),
                                    detail: cc_tool_arg_summary(input).unwrap_or_default(),
                                },
                            );
                        }
                        CodexEvent::ToolResult {
                            tool_use_id,
                            content,
                        } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::CcToolActivity {
                                    id: assistant_id_clone.clone(),
                                    call_id: tool_use_id.clone(),
                                    phase: "result".into(),
                                    tool: String::new(),
                                    detail: cc_tool_result_preview(content),
                                },
                            );
                        }
                        CodexEvent::Done { usage: Some(u) } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::Usage {
                                    id: assistant_id_clone.clone(),
                                    input_tokens: u.input_tokens,
                                    output_tokens: u.output_tokens,
                                    cost_usd: None,
                                    duration_ms: u.duration_ms,
                                },
                            );
                        }
                        _ => {}
                    }
                },
            )
            .await;

        let events = match events {
            Ok(ev) => ev,
            Err(e) => {
                let msg = if process.is_stopped() {
                    "Stream stopped by user".to_string()
                } else {
                    e
                };
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message: msg,
                });
                return Ok(());
            }
        };

        let mut final_content = String::new();
        for event in &events {
            use crate::agent::codex_bridge::protocol::CodexEvent;
            match event {
                CodexEvent::AssistantMessage { content } => {
                    final_content.push_str(content);
                }
                CodexEvent::ToolUse { name, input, .. } => {
                    final_content.push_str(&format_cc_tool_use(name, input));
                }
                CodexEvent::ToolResult { content, .. } => {
                    let preview = cc_tool_result_preview(content);
                    if !preview.is_empty() {
                        final_content.push_str(&format!("> ↳ {}\n", preview));
                    }
                }
                _ => {}
            }
        }

        let session_id = crate::agent::codex_bridge::protocol::extract_session_id(&events)
            .or_else(|| process.current_thread_id())
            .or(resume_session);
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
            attachments: Vec::new(),
        };

        let is_first = history.is_empty();
        {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
            if is_first {
                let title = user_msg.content.chars().take(40).collect::<String>();
                store::update_thread_title(&db, &req.thread_id, &title)
                    .map_err(|e| e.to_string())?;
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
    let system_prompt =
        append_agent_context_to_system_prompt(build_system_prompt(&output_format), &agent_ctx);
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
            content: crate::llm::ChatContent::text(msg.content.clone()),
        });
    }
    if let Some(attachment_message) = build_llm_attachment_message(&attachments)? {
        llm_messages.push(attachment_message);
    }
    llm_messages.push(LlmMessage::user(clean_content));

    let llm_req = ChatRequest {
        messages: llm_messages,
        max_tokens: Some(1024),
        temperature: Some(0.7),
        stream: true,
        model_override: thread.llm_model.clone().filter(|m| !m.trim().is_empty()),
        session_key: Some(thread_session_key(&thread.id)),
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
    // the long stream/tool lifetime.
    let provider_result: Result<Arc<dyn Llm>, crate::llm::LlmError> = {
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
            Some(p) => Ok(p),
            None => {
                if pinned_blocked {
                    Err(crate::llm::LlmError::VaultLocked {
                        provider: thread.provider_id.clone(),
                    })
                } else if let Some(group_id) = provider_group_id_from_route(&thread.provider_id) {
                    Err(crate::llm::LlmError::Provider {
                        status: 0,
                        message: format!(
                            "Provider group '{group_id}' has no available chat providers."
                        ),
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

    let provider = match provider_result {
        Ok(provider) => provider,
        Err(e) => {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message: e.to_string(),
            });
            return Ok(());
        }
    };

    // Create a provider-agnostic cancellation handle for this in-flight turn.
    let cancel_token = tokio_util::sync::CancellationToken::new();
    state.agent.chat_runs.lock().await.insert(
        req.thread_id.clone(),
        run::ChatRunHandle::direct_llm(cancel_token.clone()),
    );

    let mut accumulated = String::new();
    let mut is_cancelled = false;

    let mut ran_with_tools = false;
    if provider.supports_tools_for(&llm_req) {
        agent_ctx.refresh_runtime_bindings(state.inner()).await;

        let runtime_result = tokio::select! {
            _ = cancel_token.cancelled() => {
                is_cancelled = true;
                None
            }
            result = crate::agent::tool_runtime::AgentToolRuntime::provision(
                &app,
                &agent_ctx,
                ai_config.cc_bridge.confirm_readonly,
            ) => Some(result),
        };

        if let Some(runtime_result) = runtime_result {
            let runtime = match runtime_result {
                Ok(runtime) => runtime,
                Err(e) => {
                    emit(&StreamEventOut::Error {
                        id: assistant_id,
                        message: e,
                    });
                    state.agent.chat_runs.lock().await.remove(&req.thread_id);
                    return Ok(());
                }
            };

            let mcp_tools = tokio::select! {
                _ = cancel_token.cancelled() => {
                    is_cancelled = true;
                    None
                }
                result = runtime.list_tools() => Some(result),
            };

            if let Some(mcp_tools) = mcp_tools {
                let llm_tools = match mcp_tools {
                    Ok(tools) => llm_tools_from_mcp(tools),
                    Err(e) => {
                        emit(&StreamEventOut::Error {
                            id: assistant_id,
                            message: e,
                        });
                        state.agent.chat_runs.lock().await.remove(&req.thread_id);
                        return Ok(());
                    }
                };

                if !llm_tools.is_empty() {
                    ran_with_tools = true;
                    let mut messages = llm_req.messages.clone();
                    let mut completed = false;

                    // No hard tool-round cap: keep calling tools until the model
                    // returns a final answer (empty tool_calls) or the user cancels.
                    'tool_rounds: loop {
                        let turn_req = ChatRequest {
                            messages: messages.clone(),
                            max_tokens: llm_req.max_tokens,
                            temperature: llm_req.temperature,
                            stream: false,
                            model_override: llm_req.model_override.clone(),
                            session_key: llm_req.session_key.clone(),
                        };
                        let resp = tokio::select! {
                            _ = cancel_token.cancelled() => {
                                is_cancelled = true;
                                break 'tool_rounds;
                            }
                            result = provider.chat_with_tools(turn_req, llm_tools.clone()) => result,
                        };
                        let resp = match resp {
                            Ok(resp) => resp,
                            Err(e) => {
                                emit(&StreamEventOut::Error {
                                    id: assistant_id,
                                    message: e.to_string(),
                                });
                                state.agent.chat_runs.lock().await.remove(&req.thread_id);
                                return Ok(());
                            }
                        };

                        if !resp.content.is_empty() {
                            accumulated.push_str(&resp.content);
                            emit(&StreamEventOut::Token {
                                id: assistant_id.clone(),
                                content: resp.content.clone(),
                            });
                        }

                        if resp.tool_calls.is_empty() {
                            completed = true;
                            break;
                        }

                        messages.push(assistant_tool_message(&resp.content, &resp.tool_calls));
                        for call in resp.tool_calls {
                            accumulated.push_str(&format_cc_tool_use(&call.name, &call.arguments));
                            emit(&StreamEventOut::CcToolActivity {
                                id: assistant_id.clone(),
                                call_id: call.id.clone(),
                                phase: "use".into(),
                                tool: call.name.clone(),
                                detail: cc_tool_arg_summary(&call.arguments).unwrap_or_default(),
                            });

                            let tool_result = tokio::select! {
                                _ = cancel_token.cancelled() => {
                                    is_cancelled = true;
                                    break 'tool_rounds;
                                }
                                result = runtime.call_tool(&call.name, call.arguments.clone()) => result,
                            };

                            let (tool_text, is_error) = match tool_result {
                                Ok(result) => (
                                    crate::agent::tool_runtime::call_tool_result_text(&result),
                                    false,
                                ),
                                Err(e) => (format!("Tool error: {e}"), true),
                            };
                            let preview = cc_tool_result_preview(&tool_text);
                            emit(&StreamEventOut::CcToolActivity {
                                id: assistant_id.clone(),
                                call_id: call.id.clone(),
                                phase: "result".into(),
                                tool: String::new(),
                                detail: preview.clone(),
                            });
                            if !preview.is_empty() {
                                accumulated.push_str(&format!("> ↳ {}\n", preview));
                            }

                            if is_error {
                                messages.push(LlmMessage::tool_error(call.id, tool_text));
                            } else {
                                messages.push(LlmMessage::tool_result(call.id, tool_text));
                            }
                        }
                    }

                    if !completed && !is_cancelled {
                        emit(&StreamEventOut::Error {
                            id: assistant_id,
                            message: "Tool loop ended before the provider returned a final answer"
                                .into(),
                        });
                        state.agent.chat_runs.lock().await.remove(&req.thread_id);
                        return Ok(());
                    }
                }
            }
        }
    }

    if !ran_with_tools && !is_cancelled {
        let stream_result = tokio::select! {
            _ = cancel_token.cancelled() => {
                is_cancelled = true;
                None
            }
            result = provider.chat_stream(llm_req) => Some(result),
        };

        if let Some(stream_result) = stream_result {
            let mut stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    emit(&StreamEventOut::Error {
                        id: assistant_id,
                        message: e.to_string(),
                    });
                    state.agent.chat_runs.lock().await.remove(&req.thread_id);
                    return Ok(());
                }
            };

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        is_cancelled = true;
                        break;
                    }
                    evt_opt = stream.next() => {
                        match evt_opt {
                            Some(evt) => {
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
                                        state.agent.chat_runs.lock().await.remove(&req.thread_id);
                                        return Ok(());
                                    }
                                    Err(e) => {
                                        emit(&StreamEventOut::Error {
                                            id: assistant_id,
                                            message: e.to_string(),
                                        });
                                        state.agent.chat_runs.lock().await.remove(&req.thread_id);
                                        return Ok(());
                                    }
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
        }
    }

    state.agent.chat_runs.lock().await.remove(&req.thread_id);

    if is_cancelled {
        emit(&StreamEventOut::Error {
            id: assistant_id,
            message: "Stream stopped by user".into(),
        });
        return Ok(());
    }

    // Persist the assistant message and auto-title on first turn.
    let assistant_msg = store::ChatMessage {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: accumulated.clone(),
        created_at: assistant_ts,
        redacted: false,
        attachments: Vec::new(),
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
