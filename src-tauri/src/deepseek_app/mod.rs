mod action_authorization;
mod action_feedback;
pub mod action_runner;
pub mod actions;
mod agent_prompt;
pub mod archive;
mod client;
mod inline_files;
mod local_data;
mod opencode;
mod opencode_request;
mod opencode_stream;
mod opencode_tools;
mod opencode_web;
mod ordinary;
mod ordinary_responses;
mod provider_error;
pub mod search;
pub use archive::{deepseek_app_export_archive, deepseek_app_import_archive};
pub use search::{
    deepseek_app_search, deepseek_app_search_sources, deepseek_app_set_search_sources,
};
pub mod context;
pub mod files;
pub mod memory;
mod messages;
mod protocol;
mod request;
mod runtime;
pub mod speech;
mod store;
pub mod workflow;
pub use files::{deepseek_app_delete_file, deepseek_app_file_tasks, deepseek_app_upload_file};
pub use speech::{deepseek_app_asr, deepseek_app_tts};
pub mod types;

use crate::state::AppState;
pub use runtime::cancel_all;
use serde_json::Value;
use tauri::{State, ipc::Channel};
use types::{TaoEvent, TaoRequest, TaoResponse};

#[tauri::command]
pub async fn deepseek_app_send(
    request: TaoRequest,
    on_event: Channel<TaoEvent>,
    state: State<'_, AppState>,
) -> Result<TaoResponse, String> {
    messages::run(request, request::Operation::Send, on_event, state.inner()).await
}

#[tauri::command]
pub async fn deepseek_app_regenerate(
    thread_id: String,
    on_event: Channel<TaoEvent>,
    state: State<'_, AppState>,
) -> Result<TaoResponse, String> {
    let request = {
        let db = state.core.db.lock().map_err(|_| "database unavailable")?;
        store::init(&db)?;
        store::last_request(&db, &thread_id)?
    };
    messages::run(
        request,
        request::Operation::Regenerate,
        on_event,
        state.inner(),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_app_continue(
    thread_id: String,
    on_event: Channel<TaoEvent>,
    state: State<'_, AppState>,
) -> Result<TaoResponse, String> {
    let request = {
        let db = state.core.db.lock().map_err(|_| "database unavailable")?;
        store::init(&db)?;
        store::last_request(&db, &thread_id)?
    };
    messages::run(
        request,
        request::Operation::Continue,
        on_event,
        state.inner(),
    )
    .await
}

#[tauri::command]
pub fn deepseek_app_stop(thread_id: String) -> Result<(), String> {
    runtime::stop(&thread_id)
}

#[tauri::command]
pub fn deepseek_app_load_threads(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    store::init(&db)?;
    store::load_threads(&db)
}

#[tauri::command]
pub fn deepseek_app_save_thread(thread: Value, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    store::init(&db)?;
    store::save_thread(&db, thread)
}

#[tauri::command]
pub fn deepseek_app_delete_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    runtime::stop(&thread_id)?;
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    store::init(&db)?;
    store::delete_thread(&db, &thread_id)
}

#[tauri::command]
pub fn deepseek_app_clone_thread(
    source_thread_id: String,
    target_thread_id: String,
    through_message_index: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    store::init(&db)?;
    store::clone_thread(
        &db,
        &source_thread_id,
        &target_thread_id,
        through_message_index,
    )
}
