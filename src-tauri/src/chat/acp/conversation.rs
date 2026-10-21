use super::events::AcpEventAccumulator;
use super::events::emit;
use super::events::emit_error;
use super::lifetime::existing_process;
use super::lifetime::recycle_if_profile_changed;
use super::lifetime::recycle_thread_process;
use super::lifetime::resolve_process_cwd;
use super::lifetime::spawn_thread_process;
use crate::agent::acp_bridge::AcpResourceLink;
use crate::agent::acp_bridge::AcpStopReason;
use crate::agent::acp_bridge::GROK_PROFILE_ID;
use crate::agent::acp_bridge::profile_id_from_provider_id;
use crate::ai::config::AiConfig;
use crate::ai::config::default_ai_config_path;
use crate::chat::ChatSendRequest;
use crate::chat::StreamEventOut;
use crate::chat::attachments;
use crate::chat::attachments::render_agent_attachment_prefix;
use crate::chat::context;
use crate::chat::context::append_agent_context_to_system_prompt;
use crate::chat::now;
use crate::chat::redact;
use crate::chat::run;
use crate::chat::store;
use crate::chat::thread_commands::build_system_prompt;
use crate::chat::thread_commands::resolve_output_format;
use crate::state::AppState;
use futures::StreamExt;
use tauri::AppHandle;
use uuid::Uuid;

pub(in crate::chat) async fn stream(
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
                .agent
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
    state.agent.chat_runs.lock().await.insert(
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
    // Grok currently negotiates `promptCapabilities.image = false`, so never
    // send it an inline ACP image block. Its CLI can nevertheless read local
    // image `resource_link`s, which preserve the attachment as a local file
    // instead of embedding image bytes in the ACP stream.
    let resource_links = grok_image_resource_links(profile_id, attachments);
    let permission_owner_id = process.permission_owner_id().to_string();
    let mut updates = process.subscribe();
    let mut prompt_future = Box::pin(async {
        if resource_links.is_empty() {
            process.prompt(&prompt).await
        } else {
            process
                .prompt_with_resource_links(&prompt, &resource_links)
                .await
        }
    });
    let mut accumulator = AcpEventAccumulator::default();
    let prompt_result = loop {
        tokio::select! {
            result = &mut prompt_future => break result,
            update = updates.recv() => {
                match update {
                    Ok(update) => accumulator.handle(
                        app,
                        event_name,
                        &assistant_id,
                        &req.thread_id,
                        &permission_owner_id,
                        &profile.name,
                        update,
                    ),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break prompt_future.await;
                    }
                }
            }
        }
    };
    while let Ok(update) = updates.try_recv() {
        accumulator.handle(
            app,
            event_name,
            &assistant_id,
            &req.thread_id,
            &permission_owner_id,
            &profile.name,
            update,
        );
    }
    state.agent.chat_runs.lock().await.remove(&req.thread_id);

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

pub(super) fn build_prompt(
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

pub(super) fn grok_image_resource_links(
    profile_id: &str,
    attachments: &[store::ChatAttachment],
) -> Vec<AcpResourceLink> {
    if profile_id != GROK_PROFILE_ID {
        return Vec::new();
    }
    attachments
        .iter()
        .filter(|attachment| attachment.kind == "image")
        .filter_map(|attachment| {
            let path = std::fs::canonicalize(&attachment.path).ok()?;
            if !path.is_file() {
                return None;
            }
            let uri = url::Url::from_file_path(path).ok()?.to_string();
            let mime_type = attachment
                .mime
                .as_deref()
                .map(str::trim)
                .filter(|mime| !mime.is_empty())
                .map(str::to_string);
            Some(AcpResourceLink::new(
                uri,
                attachment.name.clone(),
                mime_type,
            ))
        })
        .collect()
}
