use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;

pub struct TransferHandle {
    cancelled: AtomicBool,
}

impl TransferHandle {
    pub fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Serialize, Clone)]
pub struct ProgressPayload {
    pub bytes: u64,
    pub total: u64,
    pub rate: f64,
    pub eta: f64,
}

#[derive(Serialize, Clone)]
pub struct CompletePayload {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "finalPath", skip_serializing_if = "Option::is_none")]
    pub final_path: Option<String>,
}

impl CompletePayload {
    pub fn ok(final_path: Option<String>) -> Self {
        Self { success: true, error: None, final_path }
    }
    pub fn err(message: &str) -> Self {
        Self { success: false, error: Some(message.to_string()), final_path: None }
    }
}

pub async fn register(state: &State<'_, AppState>, transfer_id: &str) -> Arc<TransferHandle> {
    let handle = Arc::new(TransferHandle::new());
    let mut transfers = state.transfers.write().await;
    transfers.insert(transfer_id.to_string(), handle.clone());
    handle
}

pub async fn unregister(state: &State<'_, AppState>, transfer_id: &str) {
    let mut transfers = state.transfers.write().await;
    transfers.remove(transfer_id);
}

pub async fn cancel(state: &State<'_, AppState>, transfer_id: &str) {
    let transfers = state.transfers.read().await;
    if let Some(handle) = transfers.get(transfer_id) {
        handle.cancel();
    }
}

/// Yield to the runtime so a long-running synchronous I/O loop has a chance
/// to interleave with progress emissions. Cheap no-op placeholder.
pub fn touch() {}
