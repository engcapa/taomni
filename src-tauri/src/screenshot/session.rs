//! Only one instance may own the desktop capture UI at a time. The OS drops
//! this lock on process exit, including crashes; the file itself is not a lease.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

pub(super) struct SessionLease {
    _file: File,
}

impl SessionLease {
    pub fn acquire() -> Result<Option<Self>, String> {
        Self::at(&std::env::temp_dir().join("taomni-capture-session.lock"))
            .map_err(|e| format!("coordinate screenshot instances: {e}"))
    }

    fn at(path: &Path) -> std::io::Result<Option<Self>> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn another_instance_cannot_capture_until_the_owner_closes() {
        let path =
            std::env::temp_dir().join(format!("taomni-capture-{}.lock", uuid::Uuid::new_v4()));
        let first = SessionLease::at(&path).unwrap().unwrap();
        assert!(SessionLease::at(&path).unwrap().is_none());
        drop(first);
        assert!(SessionLease::at(&path).unwrap().is_some());
        std::fs::remove_file(path).unwrap();
    }
}
