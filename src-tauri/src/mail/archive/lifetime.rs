use std::collections::HashMap;
use std::net::Shutdown;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
pub use taomni_mail_engine::archive::progress::ArchiveStatus;
use taomni_mail_engine::archive::progress::ScanProgress;

#[derive(Default)]
pub struct ArchiveManager {
    pub(super) jobs: Mutex<HashMap<String, Arc<ArchiveJob>>>,
    pub(crate) changes: Mutex<()>,
}
pub(super) struct ArchiveJob {
    pub(super) progress: ScanProgress,
    pub(super) running: AtomicBool,
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
            job.progress.pause.store(true, Ordering::Release);
            if let Some(socket) = job.socket.lock().map_err(|e| e.to_string())?.as_ref() {
                let _ = socket.shutdown(Shutdown::Both);
            }
            job.progress.status.lock().map_err(|e| e.to_string())?.phase =
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
