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
use crate::chat::store;
use crate::chat::thread_commands::build_system_prompt;
use crate::chat::thread_commands::resolve_output_format;
use futures::StreamExt;
use std::sync::Arc;
use tauri::Emitter;
use uuid::Uuid;

pub(super) async fn stream_codex(turn: StreamTurn<'_>) -> Result<(), String> {
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

    let assistant_id = Uuid::new_v4().to_string();
    let assistant_ts = now() + 1;
    emit(&StreamEventOut::AssistantStart {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        created_at: assistant_ts,
    });

    let ai_config = AiConfig::load(&default_ai_config_path());
    if !ai_config.codex_bridge.enabled || ai_config.fully_disabled || ai_config.full_local_mode {
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

            let thread_config = crate::agent::codex_bridge::config::build_thread_config_from_config(
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

            let temp_dir = std::env::temp_dir().join(format!(".{}", uuid::Uuid::new_v4().simple()));
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
                    state,
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
                .start_or_resume_thread(crate::agent::codex_bridge::process::CodexThreadOptions {
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
                })
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

    agent_ctx.refresh_runtime_bindings(state).await;

    if state.mobile.turn_cancel(&req.thread_id).is_cancelled() {
        process.stop().await;
        emit(&StreamEventOut::Error {
            id: assistant_id.clone(),
            message: "Turn was stopped.".into(),
        });
        return Ok(());
    }

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
