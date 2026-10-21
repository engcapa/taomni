use serde::Serialize;
use std::collections::HashMap;
use std::net::Shutdown;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

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
pub struct ArchiveManager {
    pub(super) jobs: Mutex<HashMap<String, Arc<ArchiveJob>>>,
    pub(crate) changes: Mutex<()>,
}
pub(super) struct ArchiveJob {
    pub(super) pause: AtomicBool,
    pub(super) running: AtomicBool,
    pub(super) status: Mutex<ArchiveStatus>,
    pub(super) socket: Mutex<Option<TcpStream>>,
}

impl ArchiveManager {
    /// Called only on blocking workers, never while holding an account DB lock.
    pub fn stop_account(&self, account: &str) -> Result<(), String> {
        self.pause_account(account)?;
        let job = self
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .get(account)
            .cloned();
        let started = Instant::now();
        while job
            .as_ref()
            .is_some_and(|job| job.running.load(Ordering::Acquire))
        {
            if started.elapsed() > Duration::from_secs(30) {
                return Err("Full-message storage is still stopping; retry shortly".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    pub fn pause_account(&self, account: &str) -> Result<(), String> {
        if let Some(job) = self.jobs.lock().map_err(|e| e.to_string())?.get(account) {
            job.pause.store(true, Ordering::Release);
            if let Some(socket) = job.socket.lock().map_err(|e| e.to_string())?.as_ref() {
                let _ = socket.shutdown(Shutdown::Both);
            }
            job.status.lock().map_err(|e| e.to_string())?.phase =
                if job.running.load(Ordering::Acquire) {
                    "pausing"
                } else {
                    "paused"
                }
                .into();
        }
        Ok(())
    }
}

pub(super) fn update(job: &ArchiveJob, f: impl FnOnce(&mut ArchiveStatus)) -> Result<(), String> {
    if job.pause.load(Ordering::Acquire) {
        return Err("Full-message storage paused".into());
    }
    let mut status = job.status.lock().map_err(|e| e.to_string())?;
    f(&mut status);
    Ok(())
}
