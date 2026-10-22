use crate::state::AppState;
use crate::terminal::ssh;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;

/// Single prompt forwarded to the frontend for a keyboard-interactive
/// (MFA/OTP) auth round.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SshAuthPromptEntry {
    pub(super) prompt: String,
    pub(super) echo: bool,
}

/// Payload for the `ssh-auth-prompt-{session_id}` event. The frontend renders
/// the prompts, collects the user's answers, and replies via
/// `submit_ssh_auth_response` carrying the same `request_id`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SshAuthPromptPayload {
    pub(super) request_id: String,
    pub(super) name: String,
    pub(super) instructions: String,
    pub(super) prompts: Vec<SshAuthPromptEntry>,
}

/// Build a keyboard-interactive prompter that bridges russh's auth loop to the
/// frontend: each round registers a oneshot responder keyed by a fresh request
/// id, emits the prompt event, and awaits the user's answers (or cancellation).
pub(crate) fn build_kbd_prompter(
    app_handle: AppHandle,
    responders: Arc<Mutex<HashMap<String, crate::state::SshAuthResponder>>>,
    session_id: String,
) -> ssh::KbdInteractivePrompter {
    Arc::new(move |req: ssh::KbdInteractiveRequest| {
        let app_handle = app_handle.clone();
        let responders = responders.clone();
        let session_id = session_id.clone();
        Box::pin(async move {
            let request_id = format!("{}:{}", session_id, uuid_like());
            let (tx, rx) = tokio::sync::oneshot::channel();
            {
                let mut guard = match responders.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                guard.insert(request_id.clone(), tx);
            }

            let payload = SshAuthPromptPayload {
                request_id: request_id.clone(),
                name: req.name,
                instructions: req.instructions,
                prompts: req
                    .prompts
                    .into_iter()
                    .map(|p| SshAuthPromptEntry {
                        prompt: p.prompt,
                        echo: p.echo,
                    })
                    .collect(),
            };

            if app_handle
                .emit(&format!("ssh-auth-prompt-{}", session_id), payload)
                .is_err()
            {
                // No listener / window gone — clean up and cancel.
                if let Ok(mut guard) = responders.lock() {
                    guard.remove(&request_id);
                }
                return None;
            }

            // Wait for the user's answer. A dropped sender (window closed,
            // session torn down) resolves to `Err` → treated as cancellation.
            match rx.await {
                Ok(answers) => answers,
                Err(_) => {
                    if let Ok(mut guard) = responders.lock() {
                        guard.remove(&request_id);
                    }
                    None
                }
            }
        }) as Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send>>
    })
}

/// Small unique-ish token for correlating auth prompt rounds. Avoids pulling in
/// a uuid dependency for what is only an internal, short-lived correlation id.
pub(super) fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

/// Deliver the user's answer to a pending keyboard-interactive (MFA/OTP) auth
/// round. `responses` is `None` when the user cancelled the prompt, which
/// aborts the in-flight connection. Returns `Ok(())` even when the request id
/// is unknown (the round may have already timed out or the session torn down),
/// so the frontend never has to special-case a benign race.
#[tauri::command]
pub fn submit_ssh_auth_response(
    request_id: String,
    responses: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let responder = {
        let mut guard = state
            .terminal
            .ssh_auth_responders
            .lock()
            .map_err(|_| "auth responder registry poisoned".to_string())?;
        guard.remove(&request_id)
    };
    if let Some(tx) = responder {
        // The receiver may have been dropped if connect was cancelled in the
        // meantime; ignore the send error in that case.
        let _ = tx.send(responses);
    }
    Ok(())
}

/// Drop every pending auth responder belonging to `session_id`. Called once a
/// connection attempt settles so stale rounds (which key by `session_id:<nanos>`)
/// don't accumulate. Dropping the sender resolves the waiting auth future to
/// cancellation if it somehow outlives this.
pub(crate) fn clear_session_auth_responders(
    responders: &Arc<Mutex<HashMap<String, crate::state::SshAuthResponder>>>,
    session_id: &str,
) {
    let prefix = format!("{}:", session_id);
    if let Ok(mut guard) = responders.lock() {
        guard.retain(|key, _| !key.starts_with(&prefix));
    }
}
