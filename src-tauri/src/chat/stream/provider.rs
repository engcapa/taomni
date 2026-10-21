use super::model::StreamTurn;
use super::preparation::chat_stream;
use super::tool_messages::assistant_tool_message;
use super::tool_messages::llm_tools_from_mcp;
use crate::ai::config::AiConfig;
use crate::ai::config::default_ai_config_path;
use crate::chat::StreamEventOut;
use crate::chat::attachments;
use crate::chat::attachments::build_llm_attachment_message;
use crate::chat::context::append_agent_context_to_system_prompt;
use crate::chat::now;
use crate::chat::presentation::cc_tool_arg_summary;
use crate::chat::presentation::cc_tool_result_preview;
use crate::chat::presentation::format_cc_tool_use;
use crate::chat::redact;
use crate::chat::run;
use crate::chat::store;
use crate::chat::stream;
use crate::chat::thread_commands::build_system_prompt;
use crate::chat::thread_commands::resolve_output_format;
use crate::chat::thread_commands::thread_session_key;
use crate::llm::ChatMessage as LlmMessage;
use crate::llm::ChatRequest;
use crate::llm::ChatStreamEvent;
use crate::llm::Llm;
use crate::llm::TaskKind;
use crate::llm::router::provider_group_id_from_route;
use futures::StreamExt;
use std::io::Read;
use std::sync::Arc;
use tauri::Emitter;
use uuid::Uuid;

pub(super) async fn stream_provider(turn: StreamTurn<'_>) -> Result<(), String> {
    let StreamTurn {
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
    } = turn;
    let emit = |evt: &StreamEventOut| {
        let _ = app.emit(&event_name, evt.clone());
    };
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
