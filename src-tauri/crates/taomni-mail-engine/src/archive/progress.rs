use crate::storage::scan;
use serde::Serialize;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStatus {
    pub phase: String,
    pub folder: Option<String>,
    pub saved: usize,
    pub headers_synced: usize,
    pub headers_total: Option<u32>,
    pub total: usize,
    pub bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ScanProgress {
    pub pause: AtomicBool,
    pub status: Mutex<ArchiveStatus>,
}

impl ScanProgress {
    pub fn update(&self, change: impl FnOnce(&mut ArchiveStatus)) -> Result<(), String> {
        if self.pause.load(Ordering::Acquire) {
            return Err(scan::PAUSED.into());
        }
        let mut status = self.status.lock().map_err(|e| e.to_string())?;
        change(&mut status);
        Ok(())
    }
}
