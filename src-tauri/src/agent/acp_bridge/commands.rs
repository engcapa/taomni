use super::{AcpAgentInfo, AcpProcess, AcpProfileConfig, process_config};
use crate::state::AppState;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use tauri::State;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProfileProbeResult {
    pub profile_id: String,
    pub ok: bool,
    pub message: String,
    pub agent: Option<AcpAgentInfo>,
}

/// Perform a short ACP initialize handshake for one saved profile.
///
/// Detection is intentionally independent of the bridge/profile enable
/// switches so a user can validate a draft before exposing it in Chat. The
/// command never creates a session, sends a prompt, or handles credentials.
#[tauri::command]
pub async fn acp_probe_profile(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<AcpProfileProbeResult, String> {
    let (bridge, profile) = {
        let ai_ctx = state.legacy.ai_ctx.read().await;
        if ai_ctx.config.full_local_mode || ai_ctx.config.fully_disabled {
            return Err("ACP is unavailable in full-local / fully-disabled mode.".into());
        }
        let bridge = ai_ctx.config.acp_bridge.clone();
        let profile = bridge
            .profile(&profile_id)
            .cloned()
            .ok_or_else(|| format!("ACP profile `{profile_id}` is not configured"))?;
        (bridge, profile)
    };
    let proxy_url = super::resolve_effective_proxy_url(state.inner(), &bridge, &profile)?;
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    Ok(probe_profile(&profile, proxy_url.as_deref(), &cwd).await)
}

/// Resolve one ACP agent-native permission request after the user makes an
/// explicit choice in the AI Chat safety gate. The generated call id is scoped
/// to the thread's live ACP process, and the process validates the option id
/// before replying to the local CLI.
#[tauri::command]
pub async fn acp_resolve_permission(
    window: tauri::WebviewWindow,
    thread_id: String,
    permission_owner_id: Option<String>,
    call_id: String,
    option_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    submit_permission(
        &state,
        window.label(),
        &thread_id,
        permission_owner_id.as_deref(),
        &call_id,
        Some(&option_id),
    )
    .await
}

/// Cancel using ACP's explicit cancelled outcome.
#[tauri::command]
pub async fn acp_cancel_permission(
    window: tauri::WebviewWindow,
    thread_id: String,
    permission_owner_id: Option<String>,
    call_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    submit_permission(
        &state,
        window.label(),
        &thread_id,
        permission_owner_id.as_deref(),
        &call_id,
        None,
    )
    .await
}

async fn submit_permission(
    state: &AppState,
    window: &str,
    thread: &str,
    owner: Option<&str>,
    call: &str,
    option: Option<&str>,
) -> Result<(), String> {
    let agent = &state.core.agent;
    let owner = agent
        .pending_approvals
        .take_acp(thread, owner, call, window, option)?;
    let chat = agent.acp_processes.lock().await.get(thread).cloned();
    if let Some(process) = chat.filter(|p| p.permission_owner_id() == owner) {
        return match option {
            Some(option) => process.resolve_permission(call, option).await,
            None => process.cancel_permission(call).await,
        }
        .map_err(|e| e.to_string());
    }
    let media = agent.acp_media_processes.lock().await.get(thread).cloned();
    let process = media
        .filter(|p| p.permission_owner_id() == owner)
        .ok_or("ACP approval process has ended")?;
    match option {
        Some(option) => process.resolve_permission(call, option).await,
        None => process.cancel_permission(call).await,
    }
    .map_err(|e| e.to_string())
}

pub async fn probe_profile(
    profile: &AcpProfileConfig,
    proxy_url: Option<&str>,
    cwd: &Path,
) -> AcpProfileProbeResult {
    let failure = |message: String| AcpProfileProbeResult {
        profile_id: profile.id.clone(),
        ok: false,
        message,
        agent: None,
    };
    let config = match process_config(profile, Some(cwd), proxy_url, PROBE_TIMEOUT) {
        Ok(config) => config,
        Err(error) => return failure(error),
    };
    let process = match AcpProcess::spawn(config).await {
        Ok(process) => process,
        Err(error) => return failure(error.to_string()),
    };
    let result = match process.initialize().await {
        Ok(agent) => {
            if let Some(method_id) = profile.auth_method_id.as_deref()
                && !agent
                    .auth_methods
                    .iter()
                    .any(|method| method.id == method_id)
            {
                failure(format!(
                    "Configured authentication method `{method_id}` was not advertised by the ACP agent."
                ))
            } else {
                AcpProfileProbeResult {
                    profile_id: profile.id.clone(),
                    ok: true,
                    message: probe_success_message(&agent),
                    agent: Some(agent),
                }
            }
        }
        Err(error) => failure(error.to_string()),
    };
    process.stop().await;
    result
}

fn probe_success_message(agent: &AcpAgentInfo) -> String {
    let identity = agent
        .title
        .as_deref()
        .or(agent.name.as_deref())
        .unwrap_or("ACP agent");
    match agent.version.as_deref() {
        Some(version) => format!(
            "ACP handshake succeeded: {identity} {version} (protocol v{}).",
            agent.protocol_version
        ),
        None => format!(
            "ACP handshake succeeded: {identity} (protocol v{}).",
            agent.protocol_version
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_message_uses_only_negotiated_identity() {
        let agent = AcpAgentInfo {
            protocol_version: 1,
            name: Some("agent-bin".into()),
            title: Some("Example Agent".into()),
            version: Some("2.0.1".into()),
            supports_session_load: true,
            supports_prompt_images: false,
            supports_mcp_http: true,
            supports_mcp_sse: false,
            auth_methods: Vec::new(),
        };
        assert_eq!(
            probe_success_message(&agent),
            "ACP handshake succeeded: Example Agent 2.0.1 (protocol v1)."
        );
    }
}
