use crate::storage::scan;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

pub use taomni_mail_api::archive::ArchiveStatus;

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
