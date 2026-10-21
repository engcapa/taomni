use crate::lanchat::events;
use serde::Serialize;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Emitter;

/// Progress / state update sent to the UI on `lanchat://transfer`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    /// "send" | "recv".
    pub direction: String,
    pub name: String,
    pub size: u64,
    pub transferred: u64,
    pub rate: f64,
    pub eta: f64,
    /// "offering" | "active" | "paused" | "done" | "failed" | "cancelled" | "rejected".
    pub state: String,
    pub conv_id: String,
}

pub(super) fn emit_progress(app: &AppHandle, p: &TransferProgress) {
    if let Err(e) = app.emit(events::TRANSFER, p) {
        log::warn!("lanchat: emit transfer progress failed: {e}");
    }
}

pub(super) fn rate_eta(transferred: u64, size: u64, started: Instant) -> (f64, f64) {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let rate = transferred as f64 / elapsed;
    let eta = if rate > 0.0 && size > transferred {
        (size - transferred) as f64 / rate
    } else {
        0.0
    };
    (rate, eta)
}
