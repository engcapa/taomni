use super::lifecycle::ActiveRequestGuard;
use super::lifecycle::StructuralSearchState;
use super::model::StructuralSearchCapabilities;
use super::model::StructuralSearchRequest;
use super::model::StructuralSearchResponse;
use super::model::backend_info;
use super::pattern::java_parser;
use super::search::run_structural_search;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tauri::State;

pub(super) fn validate_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 64
        && request_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[tauri::command]
pub fn structural_search_capabilities(
    state: State<'_, StructuralSearchState>,
) -> StructuralSearchCapabilities {
    StructuralSearchCapabilities {
        available: java_parser().is_ok(),
        backend: backend_info(),
        languages: vec!["java"],
        scopes: vec!["workspace", "module", "file"],
        active_requests: state.active_request_count(),
    }
}

#[tauri::command]
pub async fn structural_search_run(
    state: State<'_, StructuralSearchState>,
    request: StructuralSearchRequest,
) -> Result<StructuralSearchResponse, String> {
    if !validate_request_id(&request.request_id) {
        return Err("Invalid structural search request id".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state
            .requests
            .lock()
            .map_err(|_| "Structural search state is unavailable".to_string())?;
        if active.contains_key(&request.request_id) {
            return Err("A structural search with this id is already running".to_string());
        }
        active.insert(request.request_id.clone(), cancel.clone());
    }
    let guard = ActiveRequestGuard {
        requests: state.requests.clone(),
        request_id: request.request_id.clone(),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        run_structural_search(&request, &cancel)
    })
    .await;
    result.map_err(|error| format!("Structural search task failed: {error}"))
}

#[tauri::command]
pub fn structural_search_cancel(
    state: State<'_, StructuralSearchState>,
    request_id: String,
) -> Result<bool, String> {
    let active = state
        .requests
        .lock()
        .map_err(|_| "Structural search state is unavailable".to_string())?;
    let Some(cancel) = active.get(&request_id) else {
        return Ok(false);
    };
    cancel.store(true, Ordering::Relaxed);
    Ok(true)
}
