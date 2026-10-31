use super::model::StreamTurn;
use crate::ai::config::AiConfig;
use crate::ai::config::default_ai_config_path;
use crate::chat::StreamEventOut;
use crate::chat::attachments;
use crate::chat::attachments::render_agent_attachment_prefix;
use crate::chat::context::code_workspace_context_block;
use crate::chat::context::selected_objects_context_line;
use crate::chat::now;
use crate::chat::presentation::cc_tool_arg_summary;
use crate::chat::presentation::cc_tool_result_preview;
use crate::chat::presentation::format_cc_tool_use;
use crate::chat::redact;
use crate::chat::run;
use crate::chat::store;
use futures::StreamExt;
use std::sync::Arc;
use tauri::Emitter;
use uuid::Uuid;

pub(super) async fn stream_claude_code(turn: StreamTurn<'_>) -> Result<(), String> {
    let StreamTurn {
        req,
        app: desktop_app,
        state,
        event_name,
        thread,
        history,
        attachments,
        clean_content,
        redacted_count,
        user_msg,
        agent_ctx,
    } = turn;
    let app = desktop_app.ok_or("desktop_required")?;
    let event_thread_id = req.thread_id.clone();
    let emit = |evt: &StreamEventOut| {
        crate::chat::emit_stream_event(Some(&app), state, &event_thread_id, &event_name, evt);
    };

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
            let effective_proxy = match crate::agent::cc_bridge::config::resolve_effective_proxy_url(
                state,
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
            let control_server_url = match crate::agent::cc_bridge::mcp_http::control_server_url() {
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

    if state.mobile.turn_cancel(&req.thread_id).is_cancelled() {
        process.stop().await;
        emit(&StreamEventOut::Error {
            id: assistant_id.clone(),
            message: "Turn was stopped.".into(),
        });
        return Ok(());
    }

    // 7. Run process with callback to stream
    let assistant_id_clone = assistant_id.clone();
    let app_clone = app.clone();
    let event_name_clone = event_name.clone();
    // Refresh volatile per-turn bindings for backend-side tools: cwd for
    // run_captured and DB connection id for SQL/Redis MCP handlers.
    agent_ctx.refresh_runtime_bindings(state).await;

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
