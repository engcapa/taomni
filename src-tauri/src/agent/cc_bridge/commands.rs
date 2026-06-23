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

    // Look up the saved session id for this thread (for --resume continuity)
    // and the linked SSH session (for token trust scoping).
    let (resume_session, linked_session) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = crate::chat::store::list_threads(&db, 200)
            .ok()
            .and_then(|ts| ts.into_iter().find(|t| t.id == req.thread_id));
        match thread {
            Some(t) => (t.cc_session_id, t.linked_session_id),
            None => (None, None),
        }
    };

    // Get or create CC process for this thread. Only a *new* process writes
    // temp config files; a reused one keeps the obscure settings file it was
    // launched with (scrubbed when the session stops).
    let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
    let process = match existing {
        Some(p) => p,
        None => {
            // Provision the in-app rmcp MCP server + a per-thread scoped token.
            // This alternate path is shell-only (DB flavor selection lives in
            // the active `chat_stream` path), so it uses the Shell flavor.
            let flavor = crate::agent::cc_bridge::mcp_http::Flavor::Shell;
            let (cc_server_url, cc_token) =
                crate::agent::cc_bridge::mcp_http::provision_for_thread(
                    &app,
                    &req.thread_id,
                    linked_session.clone(),
                    flavor,
                    config.cc_bridge.confirm_readonly,
                )
                .await?;
            // Resolve the user's custom settings.json from the vault (when set).
            let custom = crate::agent::cc_bridge::config::resolve_custom_settings(
                &config.cc_bridge,
                &state.vault,
            )?;
            let files = crate::agent::cc_bridge::config::create_session_files(
                custom.as_deref(),
                flavor.server_name(),
                &cc_server_url,
                &cc_token,
            )?;

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
                "--strict-mcp-config".into(),
                "--permission-prompt-tool".into(),
                flavor.permission_prompt_tool().into(),
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

            let p = Arc::new(
                CcProcess::new(&binary, extra_args, Some(files.dir)).with_token(cc_token.clone()),
            );
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

    // Start the Weak-based liveness watchdog (idempotent).
    process.start_watchdog();

    let events = process.send(&req.message).await?;

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

/// Stop the CC process for a thread.
#[tauri::command]
pub async fn cc_stop_session(thread_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut registry = state.cc_processes.lock().await;
    if let Some(process) = registry.remove(&thread_id) {
        process.stop().await;
    }
    Ok(())
}

/// Stop and drop the CC process bound to a thread (if any) so the next send
/// re-spawns it. Use this whenever a *spawn-time* argument changes — the
/// provider switched away from `claude-code`, or the per-thread model changed —
/// since those are baked into the child's argv and a live, reused process
/// can't adopt them. Removing the Arc from the registry revokes the MCP token,
/// scrubs the temp dir (via `stop()`/`Drop`), and lets the Weak-based watchdog
/// exit. No-op when the thread has no live process.
///
/// The registry lock is released before `stop()` so we don't hold it across the
/// child kill.
pub(crate) async fn recycle_thread_process(state: &AppState, thread_id: &str) {
    let process = { state.cc_processes.lock().await.remove(thread_id) };
    if let Some(process) = process {
        process.stop().await;
    }
    // Best-effort `rm -f` of any remote (C-path) capture temp files before we
    // drop the captures; the local scrub in purge_thread can't reach a remote
    // host. The session may already be gone — failures are harmless.
    let remote = state.captures.remote_files(thread_id);
    if !remote.is_empty() {
        let terms = state.terminals.read().await;
        for (session_id, path) in remote {
            if let Some(crate::terminal::ActiveTerminal::Ssh { handle, .. }) = terms.get(&session_id) {
                crate::agent::capture::exec_c::cleanup_remote(handle, &path).await;
            }
        }
    }
    // Drop + scrub this thread's captures (方案4); their files are tied to the
    // process lifetime the same way the temp dir is.
    state.captures.purge_thread(thread_id);
}

/// Cancel an in-flight captured run (方案4). Fires the capture's cancel
/// `Notify`, which drops the SSH exec channel / kills the local child; the
/// run loop then finalizes the capture as `cancelled`. Idempotent.
#[tauri::command]
pub async fn cc_cancel_capture(
    capture_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let notify = state
        .cc_capture_cancels
        .lock()
        .map_err(|e| e.to_string())?
        .get(&capture_id)
        .cloned();
    if let Some(n) = notify {
        n.notify_waiters();
    }
    Ok(())
}

/// Resolve a pending CC side-effect tool call. The frontend calls this after it
/// has performed the effect dispatched by an `agent-cc-tool` event; the value
/// unblocks the in-app MCP server's tool handler so CC receives the result.
#[tauri::command]
pub async fn cc_resolve_tool_call(
    call_id: String,
    ok: bool,
    output: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sender = state
        .cc_pending_tool_calls
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&call_id);
    match sender {
        Some(tx) => {
            let _ = tx.send(crate::state::CcToolOutcome { ok, output });
            Ok(())
        }
        None => Err(format!("no pending CC tool call '{call_id}'")),
    }
}

/// Resolve a pending CC permission prompt with the human's decision (from the
/// ActionCard). Unblocks the in-app MCP server's `permission_prompt` handler.
#[tauri::command]
pub async fn cc_resolve_permission(
    call_id: String,
    decision: crate::state::CcPermissionDecision,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sender = state
        .cc_pending_permissions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&call_id);
    match sender {
        Some(tx) => {
            let _ = tx.send(decision);
            Ok(())
        }
        None => Err(format!("no pending CC permission prompt '{call_id}'")),
    }
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

    let (resume_session, linked_session) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = crate::chat::store::list_threads(&db, 200)
            .ok()
            .and_then(|ts| ts.into_iter().find(|t| t.id == req.thread_id));
        match thread {
            Some(t) => (t.cc_session_id, t.linked_session_id),
            None => (None, None),
        }
    };

    let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
    let process = match existing {
        Some(p) => p,
        None => {
            // Shell-only alternate path (see the streaming variant above).
            let flavor = crate::agent::cc_bridge::mcp_http::Flavor::Shell;
            let (cc_server_url, cc_token) =
                crate::agent::cc_bridge::mcp_http::provision_for_thread(
                    &app,
                    &req.thread_id,
                    linked_session.clone(),
                    flavor,
                    config.cc_bridge.confirm_readonly,
                )
                .await?;
            let custom = crate::agent::cc_bridge::config::resolve_custom_settings(
                &config.cc_bridge,
                &state.vault,
            )?;
            let files = crate::agent::cc_bridge::config::create_session_files(
                custom.as_deref(),
                flavor.server_name(),
                &cc_server_url,
                &cc_token,
            )?;

            let mut extra_args = vec![
                "--model".into(),
                config.cc_bridge.default_model.clone(),
                "--max-turns".into(),
                config.cc_bridge.max_turns.to_string(),
                "--settings".into(),
                files.settings_path.to_string_lossy().to_string(),
                "--mcp-config".into(),
                files.mcp_path.to_string_lossy().to_string(),
                "--strict-mcp-config".into(),
                "--permission-prompt-tool".into(),
                flavor.permission_prompt_tool().into(),
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

            let p = Arc::new(
                CcProcess::new(&binary, extra_args, Some(files.dir)).with_token(cc_token.clone()),
            );
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
    process.start_watchdog();
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
