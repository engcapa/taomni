use std::fs::{File, OpenOptions};
use std::path::Path;
use tauri::AppHandle;

const LOCK_FILE_NAME: &str = ".backup-operation.lock";

/// Multiple instances may share a profile, but restoring replaces SQLite files
/// and requires all other instances using that profile to have closed first.
pub struct ProfileLease(File);
impl ProfileLease {
    pub fn prepare(app_data: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(app_data.join(".profile-use.lock"))
            .map_err(|e| e.to_string())?;
        file.try_lock_shared().map_err(
            |_| "Another Taomni instance is restoring this profile; retry after it finishes",
        )?;
        let lease = Self(file);
        if app_data.join(super::restore::RESTORE_INTENT_FILE).exists()
            || app_data.join(super::restore::JOURNAL_FILE).exists()
        {
            lease.0.unlock().map_err(|e| e.to_string())?;
            lease.0.try_lock().map_err(|_| "Close the other Taomni instances using this profile before applying the pending backup restore")?;
            super::restore::apply_pending_restore(app_data)?;
            lease.0.unlock().map_err(|e| e.to_string())?;
            lease.0.lock_shared().map_err(|e| e.to_string())?;
        }
        Ok(lease)
    }
}
impl Drop for ProfileLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// Serializes backup operations across all processes using the same profile.
/// The file stays in place: ownership is the OS lock, released on close/crash.
pub struct BackupProcessLock(File);

impl BackupProcessLock {
    pub fn acquire(app: &AppHandle) -> Result<Self, String> {
        Self::acquire_at(&crate::resolved_app_data_dir(app)?)
    }

    fn open(app_data: &Path) -> Result<File, String> {
        std::fs::create_dir_all(app_data)
            .map_err(|error| format!("create backup lock directory: {error}"))?;
        OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(app_data.join(LOCK_FILE_NAME))
            .map_err(|error| format!("open backup lock: {error}"))
    }

    fn acquire_at(app_data: &Path) -> Result<Self, String> {
        let file = Self::open(app_data)?;
        file.lock()
            .map_err(|error| format!("acquire backup lock: {error}"))?;
        Ok(Self(file))
    }
}

impl Drop for BackupProcessLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::TryLockError;
    use std::io::Read;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    struct ChildGuard(Child);

    #[test]
    fn profile_allows_multiple_instances_but_rejects_restore_while_in_use() {
        let root = tempfile::tempdir().unwrap();
        let first = ProfileLease::prepare(root.path()).unwrap();
        let second = ProfileLease::prepare(root.path()).unwrap();
        let intent = root.path().join(super::super::restore::RESTORE_INTENT_FILE);
        std::fs::write(&intent, b"pending fixture").unwrap();
        let error = ProfileLease::prepare(root.path()).err().unwrap();
        assert!(error.contains("Close the other Taomni instances"));
        assert_eq!(std::fs::read(&intent).unwrap(), b"pending fixture");
        drop(first);
        drop(second);
        std::fs::remove_file(intent).unwrap();
        let _reopened = ProfileLease::prepare(root.path()).unwrap();
    }

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn backup_lock_child() {
        let Some(root) = std::env::var_os("TAOMNI_BACKUP_LOCK_TEST_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let _lock = BackupProcessLock::acquire_at(root).unwrap();
        std::fs::write(root.join("child-ready"), b"ready").unwrap();
        let mut byte = [0];
        let _ = std::io::stdin().read(&mut byte);
    }

    #[test]
    fn another_process_is_excluded_and_a_crash_releases_the_lock() {
        let root = tempfile::tempdir().unwrap();
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "backup::coordination::tests::backup_lock_child"])
                .env("TAOMNI_BACKUP_LOCK_TEST_ROOT", root.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.path().join("child-ready").exists() {
            assert!(child.0.try_wait().unwrap().is_none(), "child exited early");
            assert!(Instant::now() < deadline, "child did not acquire the lock");
            std::thread::sleep(Duration::from_millis(10));
        }
        let contender = BackupProcessLock::open(root.path()).unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(TryLockError::WouldBlock)
        ));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let _reacquired = BackupProcessLock::acquire_at(root.path()).unwrap();
        assert!(root.path().join(LOCK_FILE_NAME).is_file());
    }

    #[test]
    fn profiles_are_independent_and_completed_operations_release_ownership() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let lock = BackupProcessLock::acquire_at(first.path()).unwrap();
        let _other_profile = BackupProcessLock::acquire_at(second.path()).unwrap();
        drop(lock);
        let contender = BackupProcessLock::open(first.path()).unwrap();
        contender.try_lock().unwrap();
    }
}
