use crate::filebrowser::transfer;
use crate::filebrowser::transfer::ProgressPayload;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Emitter;

pub(super) const CHUNK_SIZE: usize = 64 * 1024;

pub(super) fn emit_progress(
    app: &AppHandle,
    transfer_id: &str,
    bytes: u64,
    total: u64,
    started: Instant,
) {
    let elapsed = started.elapsed().as_secs_f64().max(1e-3);
    let rate = (bytes as f64) / elapsed;
    let remaining = total.saturating_sub(bytes) as f64;
    let eta = if rate > 0.0 { remaining / rate } else { 0.0 };
    let _ = app.emit(
        &format!("sftp-progress-{}", transfer_id),
        ProgressPayload {
            bytes,
            total,
            rate,
            eta,
        },
    );
    transfer::touch();
}

pub(super) fn emit_paused(app: &AppHandle, transfer_id: &str, bytes: u64, total: u64) {
    // Send a zero-rate frame so the UI flips into the "paused" badge.
    let _ = app.emit(
        &format!("sftp-paused-{}", transfer_id),
        ProgressPayload {
            bytes,
            total,
            rate: 0.0,
            eta: 0.0,
        },
    );
}
