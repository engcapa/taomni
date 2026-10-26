//! Cooperative cancellation and throttled progress for blocking snapshot work.
use super::provider::TransferContext;
use std::{
    fs::File,
    io::{self, Read, Write},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

struct Progress {
    phase: &'static str,
    bytes: u64,
    total: Option<u64>,
    last_report: Instant,
}

#[derive(Clone)]
pub struct SnapshotContext {
    pub cancel: CancellationToken,
    transfer: Option<TransferContext>,
    progress: Arc<Mutex<Progress>>,
}

impl Default for SnapshotContext {
    fn default() -> Self {
        Self::new(None)
    }
}

impl SnapshotContext {
    pub fn hash(&self, path: &Path) -> io::Result<String> {
        use sha2::{Digest, Sha256};
        let mut reader = self.reader(File::open(path)?);
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        Ok(hex::encode(digest.finalize()))
    }
    pub fn new(transfer: Option<TransferContext>) -> Self {
        Self {
            cancel: transfer
                .as_ref()
                .map(|t| t.cancel.clone())
                .unwrap_or_default(),
            transfer,
            progress: Arc::new(Mutex::new(Progress {
                phase: "preparing",
                bytes: 0,
                total: None,
                last_report: Instant::now(),
            })),
        }
    }

    pub fn check(&self) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            Err("BACKUP_CANCELLED".into())
        } else {
            Ok(())
        }
    }

    pub fn begin(&self, phase: &'static str, total: Option<u64>) -> Result<(), String> {
        self.check()?;
        let mut p = self.progress.lock().map_err(|e| e.to_string())?;
        p.phase = phase;
        p.bytes = 0;
        p.total = total;
        p.last_report = Instant::now();
        if let Some(t) = &self.transfer {
            t.progress(phase, 0, total);
        }
        self.check()
    }

    pub fn advance(&self, bytes: u64) -> io::Result<()> {
        self.check().map_err(io::Error::other)?;
        let mut p = self
            .progress
            .lock()
            .map_err(|e| io::Error::other(e.to_string()))?;
        p.bytes = p.bytes.saturating_add(bytes);
        if p.last_report.elapsed() >= Duration::from_millis(200) || p.total == Some(p.bytes) {
            if let Some(t) = &self.transfer {
                t.progress(p.phase, p.bytes, p.total);
            }
            p.last_report = Instant::now();
        }
        self.check().map_err(io::Error::other)
    }

    pub fn reader<R: Read>(&self, inner: R) -> SnapshotReader<R> {
        SnapshotReader {
            inner,
            context: self.clone(),
        }
    }

    pub fn copy(&self, source: &Path, target: &Path) -> Result<(), String> {
        self.check()?;
        let mut from = self.reader(File::open(source).map_err(|e| e.to_string())?);
        let mut to = File::create(target).map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = from.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            to.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
        self.check()
    }

    pub fn lock<'a, T>(&self, mutex: &'a Mutex<T>) -> Result<MutexGuard<'a, T>, String> {
        loop {
            self.check()?;
            match mutex.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    pub fn sqlite<T>(
        &self,
        db: &rusqlite::Connection,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.check()?;
        let cancel = self.cancel.clone();
        db.progress_handler(1_000, Some(move || cancel.is_cancelled()))
            .map_err(|e| e.to_string())?;
        let _cleanup = scopeguard::guard((), |_| {
            let _ = db.progress_handler(0, None::<fn() -> bool>);
        });
        let result = operation();
        self.check()?;
        result
    }
}

pub fn hot_backup_conn(
    db: &rusqlite::Connection,
    target: &Path,
    context: &SnapshotContext,
) -> Result<(), String> {
    context.check()?;
    if target.exists() {
        std::fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    let target = target.to_str().ok_or("Invalid snapshot path")?;
    context.sqlite(db, || {
        db.execute("VACUUM INTO ?1", [target])
            .map(|_| ())
            .map_err(|e| format!("SQLite snapshot: {e}"))
    })
}

pub struct SnapshotReader<R> {
    inner: R,
    context: SnapshotContext,
}
impl<R: Read> Read for SnapshotReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.context.check().map_err(io::Error::other)?;
        let n = self.inner.read(buffer)?;
        self.context.advance(n as u64)?;
        Ok(n)
    }
}
