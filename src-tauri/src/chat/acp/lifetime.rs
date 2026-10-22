use super::events::dismiss_acp_permission;
use crate::agent::acp_bridge::AcpThreadProcess;
use crate::agent::acp_bridge::profile_id_from_provider_id;
use crate::chat::ChatSendRequest;
use crate::chat::context;
use crate::state::AppState;
use futures::StreamExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;

pub(in crate::chat) async fn recycle_if_profile_changed(
    state: &AppState,
    thread_id: &str,
    provider_id: &str,
) {
    let selected_profile = profile_id_from_provider_id(provider_id);
    let process = {
        let mut registry = state.agent.acp_processes.lock().await;
        let should_remove = registry
            .get(thread_id)
            .is_some_and(|process| Some(process.profile_id()) != selected_profile);
        should_remove.then(|| registry.remove(thread_id)).flatten()
    };
    if let Some(process) = process {
        process.stop().await;
    }
}

/// Stop an in-flight short-lived Grok media ACP process when its thread is
/// deleted or rebound to another provider. Unlike normal ACP chat processes,
/// media processes are not reusable and must never survive their owner.
pub(in crate::chat) async fn recycle_media_process(
    state: &AppState,
    app: &AppHandle,
    thread_id: &str,
) {
    let process = {
        state
            .agent
            .acp_media_processes
            .lock()
            .await
            .remove(thread_id)
    };
    if let Some(process) = process {
        let permission_owner_id = process.permission_owner_id().to_string();
        process.stop().await;
        // `stop` normally emits a Closed event, but remove a visible card here
        // as well so a deleted/rebound thread cannot retain an actionable gate.
        // Scope this to the retired media process: a reusable ACP chat process
        // for the same thread may still have its own independent card.
        dismiss_acp_permission(app, thread_id, Some(&permission_owner_id), None);
    }
}

pub(super) async fn spawn_thread_process(
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

pub(super) async fn existing_process(
    state: &AppState,
    thread_id: &str,
    profile_id: &str,
) -> Option<Arc<AcpThreadProcess>> {
    state
        .agent
        .acp_processes
        .lock()
        .await
        .get(thread_id)
        .filter(|process| process.profile_id() == profile_id && !process.is_stopped())
        .cloned()
}

pub(super) async fn recycle_thread_process(state: &AppState, thread_id: &str) {
    let process = state.agent.acp_processes.lock().await.remove(thread_id);
    if let Some(process) = process {
        process.stop().await;
    }
}

pub(super) fn resolve_process_cwd(
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
