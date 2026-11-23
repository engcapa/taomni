use std::collections::HashMap;
use std::net::Shutdown;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
pub use taomni_mail_api::archive::ArchiveStatus;
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

#[derive(Debug)]
pub(crate) struct ModuleCleanup(Weak<ArchiveManager>);

impl ModuleCleanup {
    pub(crate) fn new(manager: &Arc<ArchiveManager>) -> Self {
        Self(Arc::downgrade(manager))
    }
}

impl crate::plugin::ModuleCleanup for ModuleCleanup {
    fn prepare_stop(&self, slug: &str) -> Result<(), String> {
        if slug != taomni_mail_api::SLUG {
            return Ok(());
        }
        if let Some(manager) = self.0.upgrade() {
            // The registry holds its lifecycle lock. A concurrent start can
            // hold this mutex while checking admission against that lock.
            let _changes = manager.changes.try_lock().map_err(
                |_| "Mail archive settings or a snapshot are changing. Retry the module operation",
            )?;
            let jobs = manager
                .jobs
                .lock()
                .map_err(|e| e.to_string())?
                .values()
                .filter(|job| job.running.load(Ordering::Acquire))
                .cloned()
                .collect::<Vec<_>>();
            for job in &jobs {
                job.pause()?;
            }
            wait_for_workers(&jobs, Duration::from_secs(5))?;
        }
        Ok(())
    }
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
        wait_for_workers(job.as_slice(), Duration::from_secs(30))
    }

    pub fn pause_account(&self, account: &str) -> Result<(), String> {
        if let Some(job) = self.jobs.lock().map_err(|e| e.to_string())?.get(account) {
            job.pause()?;
        }
        Ok(())
    }
}

impl ArchiveJob {
    pub(super) fn pause(&self) -> Result<(), String> {
        self.progress.pause.store(true, Ordering::Release);
        if let Some(socket) = self.socket.lock().map_err(|e| e.to_string())?.as_ref() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        self.progress
            .status
            .lock()
            .map_err(|e| e.to_string())?
            .phase = if self.running.load(Ordering::Acquire) {
            "pausing"
        } else {
            "paused"
        }
        .into();
        Ok(())
    }
}

fn wait_for_workers(jobs: &[Arc<ArchiveJob>], timeout: Duration) -> Result<(), String> {
    let cutoff = Instant::now() + timeout;
    while jobs.iter().any(|job| job.running.load(Ordering::Acquire)) {
        if Instant::now() >= cutoff {
            return Err("Full-message storage is still stopping; retry shortly".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::ModuleCleanup as _;

    #[test]
    fn module_stop_waits_for_active_archives_without_rewriting_completed_status() {
        let manager = Arc::new(ArchiveManager::default());
        let active = Arc::new(ArchiveJob {
            progress: ScanProgress::default(),
            running: AtomicBool::new(true),
            socket: Mutex::new(None),
        });
        let completed = Arc::new(ArchiveJob {
            progress: ScanProgress {
                status: Mutex::new(ArchiveStatus {
                    phase: "completed".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            running: AtomicBool::new(false),
            socket: Mutex::new(None),
        });
        manager.jobs.lock().unwrap().extend([
            ("active".into(), active.clone()),
            ("completed".into(), completed.clone()),
        ]);
        let cleanup = ModuleCleanup::new(&manager);
        {
            let _changing_settings = manager.changes.lock().unwrap();
            assert!(cleanup.prepare_stop(taomni_mail_api::SLUG).is_err());
            assert!(!active.progress.pause.load(Ordering::Acquire));
        }
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let deadline = Instant::now() + Duration::from_secs(2);
                while !active.progress.pause.load(Ordering::Acquire) {
                    assert!(
                        Instant::now() < deadline,
                        "archive cancellation was not sent"
                    );
                    std::thread::sleep(Duration::from_millis(1));
                }
                active.running.store(false, Ordering::Release);
            });
            cleanup.prepare_stop(taomni_mail_api::SLUG).unwrap();
            assert!(!active.running.load(Ordering::Acquire));
        });
        assert_eq!(completed.progress.status.lock().unwrap().phase, "completed");
        assert!(!completed.progress.pause.load(Ordering::Acquire));
    }
}
