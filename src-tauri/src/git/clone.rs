//! Workspace Git clone: defaults, remote probing, clone execution and
//! cancellation.
//!
//! The renderer owns the dialog and progress presentation. This module owns the
//! Git process, repository configuration, token/vault handling and the rule that
//! a failed or cancelled clone must never leave a directory that looks like a
//! valid repository.

mod configure;
mod model;
mod progress;
mod registry;
mod runner;
mod settings;
mod validation;

pub use model::{GitCloneProgress, GitCloneRequest, GitCloneResult};
pub use settings::{GitCloneDefaults, GitCloneProbeRequest, GitCloneProbeResult};

use super::*;
use crate::vault::VaultStateKind;
use configure::*;
use model::progress_payload;
use model::{
    DEFAULT_TOKEN_USERNAME, GIT_CLONE_TOKEN_ID, MAX_PROGRESS_LINE, MAX_REMOTE_BRANCHES,
    PROGRESS_EVENT,
};
use registry::{cancel_task, register_task, unregister_task};
use runner::*;
use settings::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, State};
use validation::*;
use zeroize::Zeroizing;

#[tauri::command]
pub async fn git_clone_defaults(state: State<'_, AppState>) -> Result<GitCloneDefaults, String> {
    build_defaults(&state)
}

#[tauri::command]
pub async fn git_clone_probe(
    request: GitCloneProbeRequest,
    state: State<'_, AppState>,
) -> Result<GitCloneProbeResult, String> {
    let (url, proxy, token) = prepare_probe(&state, request)?;
    blocking(move || run_probe(&url, proxy, token)).await
}

#[tauri::command]
pub async fn git_clone_repository(
    request: GitCloneRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<GitCloneResult, String> {
    let task_id = request.task_id.clone();
    let destination = normalized_destination(&request.destination)?;
    normalized_url(&request.url)?;
    let proxy = resolve_proxy(
        &state,
        &request.proxy_mode,
        request.http_proxy.as_deref(),
        request.https_proxy.as_deref(),
    )?;
    let token = resolve_token(
        &state,
        request.token.as_deref(),
        request.token_username.as_deref(),
        request.use_saved_token,
    )?;
    if request.remember_token {
        let status = state.core.vault.status()?;
        if status.state != VaultStateKind::Unlocked {
            return Err("Unlock the vault before saving the Git token".into());
        }
    }
    let vault = state.core.vault.clone();
    let cancel = register_task(&task_id, &destination)?;
    let result = blocking(move || {
        let runtime = CloneRuntime {
            emit: Box::new(move |progress| {
                let _ = app.emit(PROGRESS_EVENT, progress);
            }),
            cancel,
            vault: Some(vault),
        };
        runner::run_clone(request, proxy, token, runtime)
    })
    .await;
    unregister_task(&task_id);
    result
}

#[tauri::command]
pub async fn git_clone_cancel(task_id: String) -> Result<(), String> {
    // Idempotent: the renderer may cancel just after the clone completed.
    cancel_task(&task_id);
    Ok(())
}

#[cfg(test)]
mod tests;
