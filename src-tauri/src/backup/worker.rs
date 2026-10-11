//! One cloud worker per physical SQLite path, shared by all Taomni processes.
//! A process may run multiple destinations; another process takes over when all
//! work finishes or the owner exits. No PID files or stale-lock deletion.
use std::{
    fs::{File, OpenOptions, TryLockError},
    path::Path,
    sync::{Arc, Mutex, Weak},
};

#[derive(Default)]
pub struct CloudWorker(Mutex<Weak<File>>);

impl CloudWorker {
    pub fn claim(&self, root: &Path) -> Result<Arc<File>, String> {
        let mut owner = self.0.lock().map_err(|e| e.to_string())?;
        if let Some(file) = owner.upgrade() {
            return Ok(file);
        }
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("worker.lock"))
            .map_err(|e| e.to_string())?;
        match file.try_lock() {
            Ok(()) => {},
            Err(TryLockError::WouldBlock) => return Err("BACKUP_OTHER_INSTANCE: Another Taomni instance is processing cloud backups for this SQLite database; wait for it to finish or use that window".into()),
            Err(error) => return Err(format!("Cannot lock cloud backup worker: {error}")),
        }
        let file = Arc::new(file);
        *owner = Arc::downgrade(&file);
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloud_worker_child() {
        let Some(root) = std::env::var_os("TAOMNI_CLOUD_WORKER_TEST_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let worker = CloudWorker::default();
        let _owner = worker.claim(root).unwrap();
        std::fs::write(root.join("ready"), b"ready").unwrap();
        let mut byte = [0];
        let _ = std::io::Read::read(&mut std::io::stdin(), &mut byte);
    }
    #[test]
    fn crashed_process_releases_cloud_ownership() {
        use std::{
            process::{Child, Command, Stdio},
            time::{Duration, Instant},
        };
        struct ChildGuard(Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = tempfile::tempdir().unwrap();
        let worker = CloudWorker::default();
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "backup::worker::tests::cloud_worker_child"])
                .env("TAOMNI_CLOUD_WORKER_TEST_ROOT", root.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.path().join("ready").exists() {
            assert!(child.0.try_wait().unwrap().is_none());
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            worker
                .claim(root.path())
                .unwrap_err()
                .starts_with("BACKUP_OTHER_INSTANCE")
        );
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(worker.claim(root.path()).is_ok());
    }
    #[test]
    fn shared_work_blocks_competitors_until_last_task_finishes() {
        let root = tempfile::tempdir().unwrap();
        let first = CloudWorker::default();
        let second = CloudWorker::default();
        let task_a = first.claim(root.path()).unwrap();
        let task_b = first.claim(root.path()).unwrap();
        assert!(
            second
                .claim(root.path())
                .unwrap_err()
                .starts_with("BACKUP_OTHER_INSTANCE")
        );
        drop(task_a);
        assert!(second.claim(root.path()).is_err());
        drop(task_b);
        assert!(second.claim(root.path()).is_ok());
    }
}
