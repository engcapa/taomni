use crate::agent::cc_bridge::process::CcProcess;
use crate::agent::cc_bridge::protocol::{extract_answer, extract_session_id, CcEvent};
use crate::agent::cc_bridge::{detect, CcStatusResult};
use crate::ai::config::{default_ai_config_path, AiConfig};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Per-thread CC process registry (held in AppState via a separate Mutex).
pub type CcProcessRegistry = Mutex<HashMap<String, Arc<CcProcess>>>;

/// Detect Claude Code CLI status. Returns NotFound when full-local mode is on,
/// so the frontend hides the integration without leaking that CC is installed.
#[tauri::command]
pub async fn cc_detect(state: State<'_, AppState>) -> Result<CcStatusResult, String> {
    let ai_ctx = state.ai_ctx.read().await;
    if ai_ctx.config.full_local_mode || ai_ctx.config.fully_disabled {
        return Ok(CcStatusResult {
            status: crate::agent::cc_bridge::CcStatus::NotFound,
            message: "Claude Code is hidden in full-local / fully-disabled mode.".into(),
            binary_path: None,
        });
    }
    let binary = if ai_ctx.config.cc_bridge.binary == "auto" {
        None
    } else {
        Some(ai_ctx.config.cc_bridge.binary.clone())
    };
    drop(ai_ctx);
    Ok(detect(binary.as_deref()).await)
}

/// Return the raw user-supplied Claude Code `settings.json` (decrypted from the
/// vault) so the Settings UI can load it into its editor. Returns:
/// - `Ok(None)` when no custom settings are configured.
/// - `Ok(Some(json))` the stored settings JSON.
/// - `Err("VAULT_LOCKED: …")` when a reference is set but the vault is locked.
#[tauri::command]
pub async fn cc_get_custom_settings(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let config = AiConfig::load(&default_ai_config_path());
    crate::agent::cc_bridge::config::resolve_custom_settings(&config.cc_bridge, &state.vault)
}

#[tauri::command]
pub async fn cc_get_profile_settings(
    vault_ref: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if !vault_ref.starts_with("vault:") {
        return Err("Invalid vault reference".into());
    }
    match state.vault.resolve(&vault_ref) {
        Ok(Some(plaintext)) => Ok(Some(plaintext.to_string())),
        Ok(None) => Ok(None),
        Err(e) if e.contains(crate::vault::ERR_VAULT_LOCKED) => Err(format!(
            "{}: unlock the credential vault to read settings.",
            crate::vault::ERR_VAULT_LOCKED
        )),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CcSendRequest {
    pub thread_id: String,
    pub message: String,
    /// Optional thread workspace root. Forwarded to CC via `--add-dir` so the
    /// CLI is constrained to read only that directory tree (in addition to
    /// the deny list configured in settings.json). Per the plan §9.5.5, CC
    /// must not be able to walk `~/.ssh`, the vault, or the Taomni config
    /// directory; combining `--add-dir` (allow) with the deny list double-
    /// gates these critical paths.
    #[serde(default)]
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CcSendResponse {
    pub answer: String,
    pub events: Vec<CcEvent>,
    pub tool_calls: Vec<CcToolCall>,
    pub session_id: Option<String>,
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
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled || ai_ctx.config.full_local_mode {
            return Err("Claude Code is unavailable in full-local / fully-disabled mode.".into());
        }
        if !ai_ctx.config.cc_bridge.enabled {
            return Err("Claude Code integration is disabled.".into());
        }
    }

    let config = AiConfig::load(&default_ai_config_path());
    let binary = if config.cc_bridge.binary == "auto" {
        crate::agent::cc_bridge::find_claude_binary().ok_or("Claude Code CLI not found")?
    } else {
        config.cc_bridge.binary.clone()
    };

    // Look up the saved session id for this thread (for --resume continuity).
    let resume_session = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        crate::chat::store::list_threads(&db, 200)
            .ok()
            .and_then(|ts| ts.into_iter().find(|t| t.id == req.thread_id))
            .and_then(|t| t.cc_session_id)
    };

    // Get or create CC process for this thread. Only a *new* process writes
    // temp config files; a reused one keeps the obscure settings file it was
    // launched with (scrubbed when the session stops).
    let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
    let process = match existing {
        Some(p) => p,
        None => {
            // Resolve the user's custom settings.json from the vault (when set).
            let custom = crate::agent::cc_bridge::config::resolve_custom_settings(
                &config.cc_bridge,
                &state.vault,
            )?;
            let files =
                crate::agent::cc_bridge::config::create_session_files(custom.as_deref())?;

            // Build extra args.
            let mut extra_args = vec![
                "--model".into(),
                config.cc_bridge.default_model.clone(),
                "--max-turns".into(),
                config.cc_bridge.max_turns.to_string(),
                "--settings".into(),
                files.settings_path.to_string_lossy().to_string(),
                // §36/37: route every tool call through Taomni's permission prompt
                // and expose Taomni's tool surface back to CC via --mcp-config.
                "--mcp-config".into(),
                files.mcp_path.to_string_lossy().to_string(),
                "--permission-prompt-tool".into(),
                crate::agent::cc_bridge::config::PERMISSION_PROMPT_TOOL.into(),
            ];
            // §21: thread workspace whitelist. CC walks files via the Read/Glob
            // tools; `--add-dir` constrains those to the requested workspace tree.
            if let Some(ws) = &req.workspace_dir {
                let path = PathBuf::from(ws);
                if path.is_absolute() && path.exists() {
                    extra_args.push("--add-dir".into());
                    extra_args.push(path.to_string_lossy().to_string());
                }
            }
            if let Some(sid) = &resume_session {
                extra_args.push("--resume".into());
                extra_args.push(sid.clone());
            }

            let p = Arc::new(CcProcess::new(&binary, extra_args, Some(files.dir)));
            let mut registry = state.cc_processes.lock().await;
            match registry.get(&req.thread_id) {
                Some(existing) => existing.clone(),
                None => {
                    registry.insert(req.thread_id.clone(), p.clone());
                    p
                }
            }
        }
    };

    let events = process.send(&req.message).await?;

    let answer = extract_answer(&events);
    let session_id = extract_session_id(&events).or(resume_session);

    // Persist the session id so the next call resumes the same conversation.
    if let Some(sid) = &session_id {
        if let Ok(db) = state.db.lock() {
            let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
        }
    }

    let tool_calls: Vec<CcToolCall> = events
        .iter()
        .filter_map(|e| match e {
            CcEvent::ToolUse { id, name, input } => Some(CcToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect();

    Ok(CcSendResponse {
        answer,
        events,
        tool_calls,
        session_id,
    })
}

/// Stop the CC process for a thread.
#[tauri::command]
pub async fn cc_stop_session(thread_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut registry = state.cc_processes.lock().await;
    if let Some(process) = registry.remove(&thread_id) {
        process.stop().await;
    }
    Ok(())
}

/// Streaming variant of `cc_send_message`. Emits `cc-stream:{thread_id}`
/// events for every CcEvent the CLI produces (assistant_message, tool_use,
/// partial, etc.). Resolves once the stream finishes.
#[tauri::command]
pub async fn cc_stream_message(
    req: CcSendRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CcSendResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled || ai_ctx.config.full_local_mode {
            return Err("Claude Code is unavailable in full-local / fully-disabled mode.".into());
        }
        if !ai_ctx.config.cc_bridge.enabled {
            return Err("Claude Code integration is disabled.".into());
        }
    }

    let config = AiConfig::load(&default_ai_config_path());
    let binary = if config.cc_bridge.binary == "auto" {
        crate::agent::cc_bridge::find_claude_binary().ok_or("Claude Code CLI not found")?
    } else {
        config.cc_bridge.binary.clone()
    };

    let resume_session = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        crate::chat::store::list_threads(&db, 200)
            .ok()
            .and_then(|ts| ts.into_iter().find(|t| t.id == req.thread_id))
            .and_then(|t| t.cc_session_id)
    };

    let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
    let process = match existing {
        Some(p) => p,
        None => {
            let custom = crate::agent::cc_bridge::config::resolve_custom_settings(
                &config.cc_bridge,
                &state.vault,
            )?;
            let files =
                crate::agent::cc_bridge::config::create_session_files(custom.as_deref())?;

            let mut extra_args = vec![
                "--model".into(),
                config.cc_bridge.default_model.clone(),
                "--max-turns".into(),
                config.cc_bridge.max_turns.to_string(),
                "--settings".into(),
                files.settings_path.to_string_lossy().to_string(),
            ];
            if let Some(ws) = &req.workspace_dir {
                let path = PathBuf::from(ws);
                if path.is_absolute() && path.exists() {
                    extra_args.push("--add-dir".into());
                    extra_args.push(path.to_string_lossy().to_string());
                }
            }
            if let Some(sid) = &resume_session {
                extra_args.push("--resume".into());
                extra_args.push(sid.clone());
            }

            let p = Arc::new(CcProcess::new(&binary, extra_args, Some(files.dir)));
            let mut registry = state.cc_processes.lock().await;
            match registry.get(&req.thread_id) {
                Some(existing) => existing.clone(),
                None => {
                    registry.insert(req.thread_id.clone(), p.clone());
                    p
                }
            }
        }
    };

    let event_name = format!("cc-stream:{}", req.thread_id);
    let app_clone = app.clone();
    let events = process
        .send_with_callback(&req.message, move |evt| {
            let _ = app_clone.emit(&event_name, evt.clone());
        })
        .await?;

    let answer = extract_answer(&events);
    let session_id = extract_session_id(&events).or(resume_session);
    if let Some(sid) = &session_id {
        if let Ok(db) = state.db.lock() {
            let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
        }
    }
    let tool_calls: Vec<CcToolCall> = events
        .iter()
        .filter_map(|e| match e {
            CcEvent::ToolUse { id, name, input } => Some(CcToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect();
    Ok(CcSendResponse {
        answer,
        events,
        tool_calls,
        session_id,
    })
}
