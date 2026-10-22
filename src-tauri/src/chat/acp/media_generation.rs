use super::conversation::grok_image_resource_links;
use super::events::dismiss_acp_permission;
use super::events::emit_acp_permission;
use super::media_files::copy_grok_generated_media;
use crate::agent::acp_bridge::AcpResourceLink;
use crate::agent::acp_bridge::AcpRuntimeEvent;
use crate::agent::acp_bridge::AcpStopReason;
use crate::agent::acp_bridge::GROK_PROFILE_ID;
use crate::chat::GeneratedMediaFile;
use crate::chat::MediaGenerationKind;
use crate::chat::attachments;
use crate::chat::media;
use crate::chat::store;
use crate::state::AppState;
use futures::StreamExt;
use std::sync::Arc;
use tauri::AppHandle;

/// Run Grok's native media tools through its ACP server. This is intentionally
/// separate from API-key based LLM providers: the installed `grok` CLI owns
/// authentication and emits a local artifact path when its image/video tool
/// completes.
pub(in crate::chat) async fn generate_grok_media(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    bridge: &crate::agent::acp_bridge::AcpBridgeConfig,
    profile: &crate::agent::acp_bridge::AcpProfileConfig,
    kind: MediaGenerationKind,
    prompt: &str,
    attachments: &[store::ChatAttachment],
) -> Result<GeneratedMediaFile, String> {
    if profile.id != GROK_PROFILE_ID {
        return Err("Only the built-in Grok ACP profile can generate local media.".into());
    }

    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let proxy_url = crate::agent::acp_bridge::resolve_effective_proxy_url(state, bridge, profile)?;
    let process_config = crate::agent::acp_bridge::process_config(
        profile,
        Some(&cwd),
        proxy_url.as_deref(),
        bridge.request_timeout(),
    )?;
    let process = Arc::new(
        crate::agent::acp_bridge::AcpProcess::spawn(process_config)
            .await
            .map_err(|error| error.to_string())?,
    );
    let permission_owner_id = process.permission_owner_id().to_string();
    let already_running = {
        let mut registry = state.agent.acp_media_processes.lock().await;
        if registry.contains_key(thread_id) {
            true
        } else {
            registry.insert(thread_id.to_string(), process.clone());
            false
        }
    };
    if already_running {
        process.stop().await;
        return Err("Grok media generation is already active for this chat thread.".into());
    }

    let result = async {
        let agent_info = process
            .initialize()
            .await
            .map_err(|error| error.to_string())?;
        if let Some(method_id) = profile
            .auth_method_id
            .as_deref()
            .map(str::trim)
            .filter(|method_id| !method_id.is_empty())
        {
            if !agent_info
                .auth_methods
                .iter()
                .any(|method| method.id == method_id)
            {
                return Err("Configured Grok ACP authentication method was not advertised.".into());
            }
            process
                .authenticate(method_id)
                .await
                .map_err(|error| error.to_string())?;
        }

        let session_id = process
            .new_session(&cwd.to_string_lossy(), Vec::new())
            .await
            .map_err(|error| error.to_string())?;
        let resource_links = grok_image_resource_links(&profile.id, attachments);
        let media_prompt = grok_media_prompt(kind, prompt, !resource_links.is_empty());
        let candidates = collect_grok_media_candidates(
            app,
            thread_id,
            &permission_owner_id,
            &profile.name,
            process.as_ref(),
            &session_id,
            &media_prompt,
            &resource_links,
        )
        .await?;
        copy_grok_generated_media(app, kind, &candidates, &profile.name).await
    }
    .await;

    let was_registered = {
        let mut registry = state.agent.acp_media_processes.lock().await;
        if registry
            .get(thread_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, &process))
        {
            registry.remove(thread_id).is_some()
        } else {
            false
        }
    };
    process.stop().await;
    if was_registered {
        dismiss_acp_permission(app, thread_id, Some(&permission_owner_id), None);
    }
    result
}

pub(super) fn grok_media_prompt(
    kind: MediaGenerationKind,
    prompt: &str,
    has_reference_image: bool,
) -> String {
    let instruction = match kind {
        MediaGenerationKind::Image if has_reference_image => {
            "Generate exactly one image now. Use Grok's native image_edit tool immediately, with the attached local image as the reference. Do not modify or read workspace files, and do not use any other tool. Apply this user prompt verbatim:"
        }
        MediaGenerationKind::Image => {
            "Generate exactly one new image now. Use Grok's native image_gen tool immediately. Do not modify or read workspace files, and do not use any other tool. Apply this user prompt verbatim:"
        }
        MediaGenerationKind::Video if has_reference_image => {
            "Generate exactly one video now. Use Grok's native image_to_video tool immediately with the attached local image as its first frame. Use a 6-second clip unless the user explicitly requests 10 seconds. Do not modify or read workspace files, and do not use any other tool. Apply this user prompt verbatim:"
        }
        MediaGenerationKind::Video => {
            "Generate exactly one video now. First use Grok's native image_gen tool once to create an appropriate first frame, then use image_to_video. Use a 6-second clip unless the user explicitly requests 10 seconds. Do not modify or read workspace files, and do not use any other tool. Apply this user prompt verbatim:"
        }
    };
    format!("{instruction}\n\n{prompt}")
}

pub(super) async fn collect_grok_media_candidates(
    app: &AppHandle,
    thread_id: &str,
    permission_owner_id: &str,
    source_label: &str,
    process: &crate::agent::acp_bridge::AcpProcess,
    session_id: &str,
    prompt: &str,
    resource_links: &[AcpResourceLink],
) -> Result<Vec<String>, String> {
    let mut updates = process.subscribe();
    let mut prompt_future = Box::pin(async {
        if resource_links.is_empty() {
            process.prompt(session_id, prompt).await
        } else {
            process
                .prompt_with_resource_links(session_id, prompt, resource_links)
                .await
        }
    });
    let mut candidates = Vec::new();
    let prompt_result = loop {
        tokio::select! {
            result = &mut prompt_future => break result,
            update = updates.recv() => {
                match update {
                    Ok(update) => collect_grok_media_event(
                        app,
                        thread_id,
                        permission_owner_id,
                        source_label,
                        update,
                        &mut candidates,
                    ),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break prompt_future.await,
                }
            }
        }
    };
    while let Ok(update) = updates.try_recv() {
        collect_grok_media_event(
            app,
            thread_id,
            permission_owner_id,
            source_label,
            update,
            &mut candidates,
        );
    }

    let result = prompt_result.map_err(|error| error.to_string())?;
    if result.stop_reason == AcpStopReason::Cancelled {
        return Err("Grok media generation was cancelled.".into());
    }
    Ok(candidates)
}

pub(super) fn collect_grok_media_event(
    app: &AppHandle,
    thread_id: &str,
    permission_owner_id: &str,
    source_label: &str,
    event: AcpRuntimeEvent,
    candidates: &mut Vec<String>,
) {
    match event {
        AcpRuntimeEvent::SessionUpdate(update) => {
            let Some(media) = update.generated_media else {
                return;
            };
            if !candidates.iter().any(|candidate| candidate == &media.path) {
                candidates.push(media.path);
            }
        }
        AcpRuntimeEvent::PermissionRequest(permission) => {
            emit_acp_permission(
                app,
                thread_id,
                permission_owner_id,
                source_label,
                permission,
            );
        }
        AcpRuntimeEvent::PermissionResolved { call_id } => {
            dismiss_acp_permission(app, thread_id, Some(permission_owner_id), Some(&call_id));
        }
        AcpRuntimeEvent::Closed => {
            dismiss_acp_permission(app, thread_id, Some(permission_owner_id), None)
        }
        AcpRuntimeEvent::ProtocolWarning { message } => {
            tracing::warn!("ACP protocol warning during Grok media generation: {message}");
        }
    }
}
