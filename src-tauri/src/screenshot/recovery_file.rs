//! File ownership and shutdown coordination used only after capture UI failure.
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Condvar, Mutex},
};

#[derive(Default)]
pub(super) struct Finalizers {
    pending: Mutex<usize>,
    done: Condvar,
}

impl Finalizers {
    pub fn begin(&self) -> Finalizer<'_> {
        *self.pending.lock().unwrap() += 1;
        Finalizer(self)
    }

    pub fn wait(&self) {
        drop(
            self.done
                .wait_while(self.pending.lock().unwrap(), |pending| *pending != 0)
                .unwrap(),
        );
    }
}

pub(super) struct Finalizer<'a>(&'a Finalizers);
impl Drop for Finalizer<'_> {
    fn drop(&mut self) {
        *self.0.pending.lock().unwrap() -= 1;
        self.0.done.notify_all();
    }
}

/// `directory` is a new, exclusively owned UUID subdirectory outside screenshot
/// temp storage. Publish only a finalized, flushed file. Keep the source on any
/// copy failure so the native error dialog can give its actual location.
pub(super) fn preserve(source: &Path, directory: &Path) -> io::Result<PathBuf> {
    let name = source
        .file_name()
        .ok_or_else(|| io::Error::other("recording has no filename"))?;
    fs::create_dir_all(
        directory
            .parent()
            .ok_or_else(|| io::Error::other("missing recovery directory"))?,
    )?;
    fs::create_dir(directory)?;
    let target = directory.join(name);
    let partial = directory.join("recording.partial");
    let result = (|| {
        let mut input = fs::File::open(source)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)?;
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        drop(output);
        drop(input);
        fs::rename(&partial, &target)?;
        Ok(target.clone())
    })();
    if result.is_ok() {
        let _ = fs::remove_file(source);
    } else {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_dir(directory);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, mpsc};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "taomni-recovery-file-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn saved_recording_survives_temp_cleanup_and_preserves_exact_bytes() {
        let root = Temp::new();
        let temporary = root.0.join("temp");
        fs::create_dir(&temporary).unwrap();
        let source = temporary.join("clip.mp4");
        let content = vec![42; 256 * 1024];
        fs::write(&source, &content).unwrap();
        let target = preserve(&source, &root.0.join("saved/unique")).unwrap();
        fs::remove_dir_all(&temporary).unwrap();
        assert_eq!(fs::read(target).unwrap(), content);
    }

    #[test]
    fn failed_save_keeps_source_and_cannot_overwrite_existing_recovery() {
        let root = Temp::new();
        let source = root.0.join("clip.gif");
        fs::write(&source, b"new").unwrap();
        let directory = root.0.join("existing");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("clip.gif"), b"old").unwrap();
        assert!(preserve(&source, &directory).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"new");
        assert_eq!(fs::read(directory.join("clip.gif")).unwrap(), b"old");
        assert!(preserve(&root.0.join("missing.gif"), &root.0.join("new-dir")).is_err());
        assert!(!root.0.join("new-dir").exists());
    }

    #[test]
    fn shutdown_waits_until_every_finalization_owner_releases() {
        let pending = Arc::new(Finalizers::default());
        let first = pending.begin();
        let second = pending.begin();
        let (tx, rx) = mpsc::channel();
        let worker_pending = pending.clone();
        let thread = std::thread::spawn(move || {
            worker_pending.wait();
            tx.send(()).unwrap();
        });
        assert!(rx.try_recv().is_err());
        drop(first);
        assert!(rx.try_recv().is_err());
        drop(second);
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        thread.join().unwrap();
    }
}
