use crate::agent::cc_bridge::{detect, CcStatusResult};
use crate::agent::cc_bridge::process::CcProcess;
use crate::agent::cc_bridge::protocol::{CcEvent, extract_answer};
use crate::agent::cc_bridge::config::{write_temp_settings, write_temp_mcp_config, sensitive_deny_dirs};
use crate::ai::config::{AiConfig, default_ai_config_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use crate::state::AppState;

/// Per-thread CC process registry (held in AppState via a separate Mutex).
pub type CcProcessRegistry = Mutex<HashMap<String, Arc<CcProcess>>>;

/// Detect Claude Code CLI status.
#[tauri::command]
pub async fn cc_detect() -> Result<CcStatusResult, String> {
    let config = AiConfig::load(&default_ai_config_path());
    let binary = if config.cc_bridge.binary == "auto" { None } else { Some(config.cc_bridge.binary.as_str()) };
    Ok(detect(binary).await)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CcSendRequest {
    pub thread_id: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct CcSendResponse {
    pub answer: String,
    pub events: Vec<CcEvent>,
    pub tool_calls: Vec<CcToolCall>,
}

#[derive(Debug, Serialize)]
pub struct CcToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// Send a message to Claude Code for a given thread.
/// Spawns a CC process if one isn't running for this thread.
#[tauri::command]
pub async fn cc_send_message(
    req: CcSendRequest,
    state: State<'_, AppState>,
) -> Result<CcSendResponse, String> {
    let config = AiConfig::load(&default_ai_config_path());
    if !config.cc_bridge.enabled {
        return Err("Claude Code integration is disabled.".into());
    }

    let binary = if config.cc_bridge.binary == "auto" {
        crate::agent::cc_bridge::find_claude_binary()
            .ok_or("Claude Code CLI not found")?
    } else {
        config.cc_bridge.binary.clone()
    };

    // Write temp config files.
    let tmp_dir = std::env::temp_dir().join(format!("newmob-cc-{}", &req.thread_id[..8]));
    let settings_path = tmp_dir.join("settings.json");
    let mcp_path = tmp_dir.join(".mcp.json");

    write_temp_settings(&config.cc_bridge.permission_mode, &sensitive_deny_dirs(), &settings_path)
        .map_err(|e| format!("Failed to write CC settings: {}", e))?;
    write_temp_mcp_config(&mcp_path)
        .map_err(|e| format!("Failed to write CC MCP config: {}", e))?;

    // Build extra args.
    let mut extra_args = vec![
        "--model".into(), config.cc_bridge.default_model.clone(),
        "--max-turns".into(), config.cc_bridge.max_turns.to_string(),
        "--settings".into(), settings_path.to_string_lossy().to_string(),
    ];

    // Get or create CC process for this thread.
    let process = {
        let mut registry = state.cc_processes.lock().await;
        registry.entry(req.thread_id.clone())
            .or_insert_with(|| Arc::new(CcProcess::new(&binary, extra_args)))
            .clone()
    };

    let events = process.send(&req.message).await?;

    let answer = extract_answer(&events);
    let tool_calls: Vec<CcToolCall> = events.iter()
        .filter_map(|e| match e {
            CcEvent::ToolUse { id, name, input } => Some(CcToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect();

    Ok(CcSendResponse { answer, events, tool_calls })
}

/// Stop the CC process for a thread.
#[tauri::command]
pub async fn cc_stop_session(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut registry = state.cc_processes.lock().await;
    if let Some(process) = registry.remove(&thread_id) {
        process.stop().await;
    }
    Ok(())
}
