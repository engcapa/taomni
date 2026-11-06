//! Transient connection challenges, owned by one open request and paired device.
//! Answers go straight to the waiter; neither the poll response nor persistence
//! contains a credential. Desktop and phone share SSH's one-shot responder.
use super::{OpenRequests, Outcome, PENDING_TIMEOUT};
use crate::{mobile::MobileRuntime, state::AppState};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{Manager, State};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize, Serialize)]
pub struct Prompt {
    pub prompt: String,
    pub echo: bool,
    #[serde(default)]
    pub initial: String,
}
#[derive(Serialize)]
pub struct Challenge {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<Prompt>,
}
enum Reply {
    Direct(Option<oneshot::Sender<Option<Vec<String>>>>),
    Ssh(
        Arc<Mutex<HashMap<String, crate::state::SshAuthResponder>>>,
        String,
    ),
}
impl Reply {
    fn send(&mut self, answer: Option<Vec<String>>) -> bool {
        let sender = match self {
            Self::Direct(sender) => sender.take(),
            Self::Ssh(responders, id) => responders
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id),
        };
        sender.is_some_and(|sender| sender.send(answer).is_ok())
    }
}
pub(super) struct PendingChallenge {
    pub challenge: Challenge,
    reply: Reply,
}
impl Drop for PendingChallenge {
    fn drop(&mut self) {
        self.reply.send(None);
    }
}

impl OpenRequests {
    fn publish(
        &self,
        request_id: &str,
        name: String,
        instructions: String,
        prompts: Vec<Prompt>,
        reply: Reply,
    ) -> Result<String, String> {
        if prompts.len() > 16
            || name.len() > 4096
            || instructions.len() > 8192
            || prompts
                .iter()
                .any(|p| p.prompt.len() > 4096 || p.initial.len() > 8192)
        {
            return Err("invalid_auth_challenge".into());
        }
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut requests);
        let request = requests
            .get_mut(request_id)
            .filter(|r| r.claimed && r.outcome == Outcome::Pending)
            .ok_or("open_cancelled")?;
        if request.auth.is_some() {
            return Err("auth_busy".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        request.auth = Some(PendingChallenge {
            challenge: Challenge {
                id: id.clone(),
                name,
                instructions,
                prompts,
            },
            reply,
        });
        Ok(id)
    }
    pub fn clear_challenge(&self, request_id: &str, challenge_id: &str) {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(request) = requests.get_mut(request_id) {
            if request
                .auth
                .as_ref()
                .is_some_and(|a| a.challenge.id == challenge_id)
            {
                request.auth = None;
            }
        }
    }
    pub fn answer(
        &self,
        device: &str,
        request_id: &str,
        challenge_id: &str,
        responses: Option<Vec<String>>,
    ) -> Result<(), String> {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut requests);
        let request = requests
            .get_mut(request_id)
            .filter(|r| r.device == device)
            .ok_or("open_request_not_found")?;
        let challenge = request
            .auth
            .as_ref()
            .filter(|a| a.challenge.id == challenge_id && request.outcome == Outcome::Pending)
            .ok_or("already_resolved")?;
        if responses.as_ref().is_some_and(|values| {
            values.len() != challenge.challenge.prompts.len()
                || values.iter().any(|v| v.len() > 8192)
        }) {
            return Err("invalid_auth_response".into());
        }
        let cancelled = responses.is_none();
        let sent = request
            .auth
            .take()
            .is_some_and(|mut challenge| challenge.reply.send(responses));
        if cancelled {
            request.outcome = Outcome::Failed("open_cancelled".into());
            request.cancel.cancel();
        }
        if sent {
            Ok(())
        } else {
            Err("already_resolved".into())
        }
    }
    pub fn cancellation(
        &self,
        id: &str,
    ) -> Result<(CancellationToken, std::time::Duration), String> {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut requests);
        let request = requests
            .get(id)
            .filter(|r| r.claimed && r.outcome == Outcome::Pending)
            .ok_or("open_cancelled")?;
        Ok((
            request.cancel.clone(),
            PENDING_TIMEOUT.saturating_sub(Instant::now().duration_since(request.created)),
        ))
    }
    /// Linearize the final synchronous launch/registration with cancellation.
    /// No terminal side effects may start after the request has ended.
    pub fn while_pending<T>(
        &self,
        id: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut requests);
        requests
            .get(id)
            .filter(|r| r.claimed && r.outcome == Outcome::Pending)
            .ok_or("open_cancelled")?;
        action()
    }
    pub fn bind_terminal(&self, id: &str, terminal: &str) -> Result<(), String> {
        self.cancellation(id)?;
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        let request = requests
            .get_mut(id)
            .filter(|r| r.claimed && r.outcome == Outcome::Pending)
            .ok_or("open_cancelled")?;
        if request.terminal.is_some() {
            return Err("already_resolved".into());
        }
        request.terminal = Some(terminal.into());
        Ok(())
    }
    pub fn cancel(&self, device: &str, id: &str) -> Result<(), String> {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        let request = requests
            .get_mut(id)
            .filter(|r| r.device == device)
            .ok_or("open_request_not_found")?;
        if request.outcome == Outcome::Pending {
            request.outcome = Outcome::Failed("open_cancelled".into());
            request.auth = None;
            request.cancel.cancel();
        }
        Ok(())
    }
    pub fn cancel_pending(&self, device: Option<&str>) {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        for request in requests
            .values_mut()
            .filter(|r| device.is_none_or(|d| r.device == d) && r.outcome == Outcome::Pending)
        {
            request.outcome = Outcome::Failed("open_cancelled".into());
            request.auth = None;
            request.cancel.cancel();
        }
    }
    pub fn publish_ssh(
        &self,
        id: &str,
        name: String,
        instructions: String,
        prompts: Vec<Prompt>,
        responders: Arc<Mutex<HashMap<String, crate::state::SshAuthResponder>>>,
        round: String,
    ) -> Result<String, String> {
        self.publish(
            id,
            name,
            instructions,
            prompts,
            Reply::Ssh(responders, round),
        )
    }
    pub async fn ask(
        &self,
        id: &str,
        name: String,
        instructions: String,
        prompts: Vec<Prompt>,
    ) -> Result<Vec<String>, String> {
        let (cancel, remaining) = self.cancellation(id)?;
        let (tx, rx) = oneshot::channel();
        let challenge_id =
            self.publish(id, name, instructions, prompts, Reply::Direct(Some(tx)))?;
        let result = tokio::select! {
            answer = rx => answer.ok().flatten().ok_or_else(|| "open_cancelled".to_string()),
            _ = cancel.cancelled() => Err("open_cancelled".into()),
            _ = tokio::time::sleep(remaining) => Err("open_timeout".into()),
        };
        self.clear_challenge(id, &challenge_id);
        result
    }
}

#[derive(Clone)]
pub struct MobileAuthContext {
    pub runtime: Arc<MobileRuntime>,
    pub request_id: String,
}

/// Cancellation owns the whole asynchronous preparation, including OpenSSH
/// probes/routes. Dropping the operation also drops kill-on-drop processes.
pub async fn during_connection<T>(
    mobile: Option<&MobileAuthContext>,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if let Some(mobile) = mobile {
        let (cancel, remaining) = mobile
            .runtime
            .open_requests
            .cancellation(&mobile.request_id)?;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("open_cancelled".into()),
            _ = tokio::time::sleep(remaining) => Err("open_timeout".into()),
            result = operation => result,
        }
    } else {
        operation.await
    }
}

#[tauri::command]
pub async fn mobile_connection_auth(
    request_id: String,
    name: String,
    instructions: String,
    prompts: Vec<Prompt>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    if window.label() != "main" {
        return Err("desktop_required".into());
    }
    let runtime = state.mobile.clone();
    runtime
        .open_requests
        .ask(&request_id, name, instructions, prompts)
        .await
}

#[tauri::command]
pub fn mobile_cancel_open_session(
    request_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("desktop_required".into());
    }
    Ok(state
        .mobile
        .open_requests
        .resolve(&request_id, Err("open_cancelled".into())))
}

/// Only the main desktop can bind a claimed request to a new SSH attempt.
pub fn context(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    request: Option<String>,
    terminal: &str,
) -> Result<Option<MobileAuthContext>, String> {
    let Some(request_id) = request else {
        return Ok(None);
    };
    if window.label() != "main" {
        return Err("desktop_required".into());
    }
    let runtime = app.state::<AppState>().mobile.clone();
    runtime.open_requests.bind_terminal(&request_id, terminal)?;
    Ok(Some(MobileAuthContext {
        runtime,
        request_id,
    }))
}

#[cfg(test)]
#[path = "connection_auth_tests.rs"]
mod tests;
