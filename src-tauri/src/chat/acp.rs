use super::*;
use crate::agent::acp_bridge::{
    AcpRuntimeEvent, AcpStopReason, AcpThreadProcess, profile_id_from_provider_id,
};
use crate::agent::local::LocalAgentEvent;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(super) async fn recycle_if_profile_changed(
    state: &AppState,
    thread_id: &str,
    provider_id: &str,
) {
    let selected_profile = profile_id_from_provider_id(provider_id);
    let process = {
        let mut registry = state.acp_processes.lock().await;
        let should_remove = registry
            .get(thread_id)
            .is_some_and(|process| Some(process.profile_id()) != selected_profile);
        should_remove.then(|| registry.remove(thread_id)).flatten()
    };
    if let Some(process) = process {
        process.stop().await;
    }
}

pub(super) async fn stream(
    req: &ChatSendRequest,
    app: &AppHandle,
    state: &AppState,
    event_name: &str,
    thread: &store::ChatThread,
    history: &[store::ChatMessage],
    attachments: &[store::ChatAttachment],
    clean_content: &str,
    redacted_count: usize,
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> Result<(), String> {
    let assistant_id = Uuid::new_v4().to_string();
    let assistant_ts = now() + 1;
    emit(
        app,
        event_name,
        StreamEventOut::AssistantStart {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            created_at: assistant_ts,
        },
    );

    let profile_id = profile_id_from_provider_id(&thread.provider_id)
        .ok_or_else(|| "invalid ACP provider id".to_string())?;
    let ai_config = AiConfig::load(&default_ai_config_path());
    let bridge = &ai_config.acp_bridge;
    let Some(profile) = bridge.profile(profile_id).cloned() else {
        emit_error(
            app,
            event_name,
            &assistant_id,
            format!("ACP profile `{profile_id}` is not configured."),
        );
        return Ok(());
    };
    if !bridge.enabled || !profile.enabled || ai_config.fully_disabled || ai_config.full_local_mode
    {
        recycle_thread_process(state, &req.thread_id).await;
        emit_error(
            app,
            event_name,
            &assistant_id,
            "ACP is unavailable in full-local / fully-disabled mode or the bridge/profile is disabled."
                .into(),
        );
        return Ok(());
    }

    recycle_if_profile_changed(state, &req.thread_id, &thread.provider_id).await;
    let cwd = resolve_process_cwd(req, agent_ctx)?;
    let (process, session_id) = match existing_process(state, &req.thread_id, profile_id).await {
        Some(process) => {
            let session_id = match process
                .ensure_session(
                    thread.acp_session_id.as_deref(),
                    &cwd.to_string_lossy(),
                    Vec::new(),
                )
                .await
            {
                Ok(session_id) => session_id,
                Err(error) => {
                    recycle_thread_process(state, &req.thread_id).await;
                    emit_error(app, event_name, &assistant_id, error.to_string());
                    return Ok(());
                }
            };
            (process, session_id)
        }
        None => {
            let (process, session_id) = match spawn_thread_process(
                req,
                app,
                state,
                agent_ctx,
                bridge,
                &profile,
                &cwd,
                thread.acp_session_id.as_deref(),
            )
            .await
            {
                Ok(result) => result,
                Err(message) => {
                    emit_error(app, event_name, &assistant_id, message);
                    return Ok(());
                }
            };
            state
                .acp_processes
                .lock()
                .await
                .insert(req.thread_id.clone(), process.clone());
            (process, session_id)
        }
    };
    if let Ok(db) = state.db.lock() {
        let _ = store::set_acp_session_id(&db, &req.thread_id, &session_id);
    }

    agent_ctx.refresh_runtime_bindings(state).await;
    state.chat_runs.lock().await.insert(
        req.thread_id.clone(),
        run::ChatRunHandle::bridge_process(thread.provider_id.clone(), process.clone()),
    );

    let prompt = build_prompt(
        thread,
        history,
        attachments,
        clean_content,
        req.terminal_context.as_deref(),
        agent_ctx,
        &ai_config,
    );
    let mut updates = process.subscribe();
    let mut prompt_future = Box::pin(process.prompt(&prompt));
    let mut accumulator = AcpEventAccumulator::default();
    let prompt_result = loop {
        tokio::select! {
            result = &mut prompt_future => break result,
            update = updates.recv() => {
                match update {
                    Ok(update) => accumulator.handle(app, event_name, &assistant_id, update),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break prompt_future.await;
                    }
                }
            }
        }
    };
    while let Ok(update) = updates.try_recv() {
        accumulator.handle(app, event_name, &assistant_id, update);
    }
    state.chat_runs.lock().await.remove(&req.thread_id);

    let result = match prompt_result {
        Ok(result) => result,
        Err(error) => {
            let stopped = process.is_stopped();
            recycle_thread_process(state, &req.thread_id).await;
            emit_error(
                app,
                event_name,
                &assistant_id,
                if stopped {
                    "Stream stopped by user".into()
                } else {
                    error.to_string()
                },
            );
            return Ok(());
        }
    };

    if result.stop_reason == AcpStopReason::Cancelled {
        emit_error(
            app,
            event_name,
            &assistant_id,
            "ACP turn was cancelled.".into(),
        );
        return Ok(());
    }
    if let Some(usage) = result.usage {
        emit(
            app,
            event_name,
            StreamEventOut::Usage {
                id: assistant_id.clone(),
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cost_usd: usage.total_cost_usd,
                duration_ms: usage.duration_ms,
            },
        );
    }

    let final_content = accumulator.content;
    let assistant_msg = store::ChatMessage {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: final_content.clone(),
        created_at: assistant_ts,
        redacted: false,
        attachments: Vec::new(),
    };
    {
        let db = state.db.lock().map_err(|error| error.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|error| error.to_string())?;
        if history.is_empty() {
            let title = clean_content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title)
                .map_err(|error| error.to_string())?;
        }
    }

    emit(
        app,
        event_name,
        StreamEventOut::End {
            id: assistant_id,
            thread_id: req.thread_id.clone(),
            content: final_content,
            redacted_count,
        },
    );
    Ok(())
}

async fn spawn_thread_process(
    req: &ChatSendRequest,
    app: &AppHandle,
    state: &AppState,
    agent_ctx: &crate::agent::context::AgentThreadContext,
    bridge: &crate::agent::acp_bridge::AcpBridgeConfig,
    profile: &crate::agent::acp_bridge::AcpProfileConfig,
    cwd: &Path,
    resume_session_id: Option<&str>,
) -> Result<(Arc<AcpThreadProcess>, String), String> {
    let proxy_url = crate::agent::acp_bridge::resolve_effective_proxy_url(state, bridge, profile)?;
    let process_config = crate::agent::acp_bridge::process_config(
        profile,
        Some(cwd),
        proxy_url.as_deref(),
        bridge.request_timeout(),
    )?;
    let (server_url, token) = crate::agent::mcp_bridge::provision_for_thread(
        app,
        &req.thread_id,
        agent_ctx.linked_session_id.clone(),
        agent_ctx.bound_session_id.clone(),
        agent_ctx.flavor,
        false,
    )
    .await?;
    let control_url = match crate::agent::mcp_bridge::control_server_url() {
        Ok(url) => url,
        Err(error) => {
            crate::agent::mcp_bridge::revoke_token(&token);
            return Err(error);
        }
    };
    let mcp_servers = crate::agent::mcp_bridge::acp_http_servers(
        agent_ctx.flavor,
        &server_url,
        &control_url,
        &token,
    );
    let process = Arc::new(
        AcpThreadProcess::spawn(
            profile.id.clone(),
            process_config,
            profile.auth_method_id.as_deref(),
            token,
        )
        .await
        .map_err(|error| error.to_string())?,
    );
    let mcp_servers = process
        .agent_info()
        .supports_mcp_http
        .then_some(mcp_servers)
        .unwrap_or_default();
    let session_id = match process
        .ensure_session(resume_session_id, &cwd.to_string_lossy(), mcp_servers)
        .await
    {
        Ok(session_id) => session_id,
        Err(error) => {
            process.stop().await;
            return Err(error.to_string());
        }
    };
    Ok((process, session_id))
}

async fn existing_process(
    state: &AppState,
    thread_id: &str,
    profile_id: &str,
) -> Option<Arc<AcpThreadProcess>> {
    state
        .acp_processes
        .lock()
        .await
        .get(thread_id)
        .filter(|process| process.profile_id() == profile_id && !process.is_stopped())
        .cloned()
}

async fn recycle_thread_process(state: &AppState, thread_id: &str) {
    let process = state.acp_processes.lock().await.remove(thread_id);
    if let Some(process) = process {
        process.stop().await;
    }
}

fn resolve_process_cwd(
    req: &ChatSendRequest,
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> Result<PathBuf, String> {
    let base = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut candidates = Vec::new();
    if let Some(cwd) = req.cwd.as_deref() {
        candidates.push(cwd);
    }
    if let Some(workspace) = agent_ctx.code_workspace.as_ref() {
        if !workspace.repo_root.trim().is_empty() {
            candidates.push(&workspace.repo_root);
        }
        candidates.extend(workspace.roots.iter().map(|root| root.path.as_str()));
    }
    for candidate in candidates {
        let candidate = candidate.trim();
        if candidate.is_empty() {
            continue;
        }
        let path = PathBuf::from(candidate);
        let absolute = if path.is_absolute() {
            path
        } else {
            base.join(path)
        };
        if absolute.is_dir() {
            return Ok(absolute);
        }
    }
    Ok(base)
}

fn build_prompt(
    thread: &store::ChatThread,
    history: &[store::ChatMessage],
    attachments: &[store::ChatAttachment],
    clean_content: &str,
    terminal_context: Option<&str>,
    agent_ctx: &crate::agent::context::AgentThreadContext,
    ai_config: &AiConfig,
) -> String {
    let output_format = resolve_output_format(thread, ai_config);
    let mut prompt =
        append_agent_context_to_system_prompt(build_system_prompt(&output_format), agent_ctx);
    prompt.push_str(
        "\n\nYou are connected through ACP inside Taomni. Use the scoped Taomni MCP tools for the bound terminal/database session and taomni_control for saved-session or tab actions.",
    );
    if thread.acp_session_id.is_none() && !history.is_empty() {
        prompt.push_str("\n\n[Prior Taomni chat context]\n");
        let mut used = 0_usize;
        for message in history.iter().rev().take(8).rev() {
            let remaining = 12_000_usize.saturating_sub(used);
            if remaining == 0 {
                break;
            }
            let content = message.content.chars().take(remaining).collect::<String>();
            used += content.chars().count();
            prompt.push_str(&format!("{}: {}\n", message.role, content));
        }
    }
    if let Some(context) = terminal_context.filter(|context| !context.trim().is_empty()) {
        let (context, _) = redact::redact(context);
        prompt.push_str(&format!("\n\n[Terminal context]\n```\n{context}\n```"));
    }
    prompt.push_str("\n\n");
    prompt.push_str(&render_agent_attachment_prefix(attachments));
    prompt.push_str(clean_content);
    prompt
}

#[derive(Default)]
struct AcpEventAccumulator {
    content: String,
    tool_names: HashMap<String, String>,
}

impl AcpEventAccumulator {
    fn handle(
        &mut self,
        app: &AppHandle,
        event_name: &str,
        assistant_id: &str,
        event: AcpRuntimeEvent,
    ) {
        match event {
            AcpRuntimeEvent::SessionUpdate(update) if !update.is_replay => {
                if let Some(event) = update.event {
                    self.handle_local_event(app, event_name, assistant_id, event);
                }
            }
            AcpRuntimeEvent::ProtocolWarning { message } => {
                tracing::warn!("ACP protocol warning: {message}");
            }
            AcpRuntimeEvent::Closed | AcpRuntimeEvent::SessionUpdate(_) => {}
        }
    }

    fn handle_local_event(
        &mut self,
        app: &AppHandle,
        event_name: &str,
        assistant_id: &str,
        event: LocalAgentEvent,
    ) {
        match event {
            LocalAgentEvent::AssistantDelta { content }
            | LocalAgentEvent::AssistantMessage { content } => {
                self.content.push_str(&content);
                emit(
                    app,
                    event_name,
                    StreamEventOut::Token {
                        id: assistant_id.into(),
                        content,
                    },
                );
            }
            LocalAgentEvent::ToolStarted {
                id, name, input, ..
            } => {
                self.tool_names.insert(id.clone(), name.clone());
                self.content.push_str(&format_cc_tool_use(&name, &input));
                emit(
                    app,
                    event_name,
                    StreamEventOut::CcToolActivity {
                        id: assistant_id.into(),
                        call_id: id,
                        phase: "use".into(),
                        tool: name,
                        detail: cc_tool_arg_summary(&input).unwrap_or("").into(),
                    },
                );
            }
            LocalAgentEvent::ToolCompleted { id, output } => {
                let preview = cc_tool_result_preview(&output);
                if !preview.is_empty() {
                    self.content.push_str(&format!("> ↳ {preview}\n"));
                }
                emit(
                    app,
                    event_name,
                    StreamEventOut::CcToolActivity {
                        id: assistant_id.into(),
                        call_id: id.clone(),
                        phase: "result".into(),
                        tool: self.tool_names.remove(&id).unwrap_or_default(),
                        detail: preview,
                    },
                );
            }
            LocalAgentEvent::Error { message } => {
                tracing::warn!("ACP agent event error: {message}");
            }
            LocalAgentEvent::SessionStarted { .. } | LocalAgentEvent::Done { .. } => {}
        }
    }
}

fn emit(app: &AppHandle, event_name: &str, event: StreamEventOut) {
    let _ = app.emit(event_name, event);
}

fn emit_error(app: &AppHandle, event_name: &str, assistant_id: &str, message: String) {
    emit(
        app,
        event_name,
        StreamEventOut::Error {
            id: assistant_id.into(),
            message,
        },
    );
}
