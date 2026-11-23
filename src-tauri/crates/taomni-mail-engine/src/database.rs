//! Short account-scoped OS locks protect SQLite references and immutable files
//! across application processes. Network and MIME work never holds this lock.
use rusqlite::Connection;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const MAIL_MUTATION_LOCK: &str = "mutation";

pub fn configured_directory(options: &str, default: &Path) -> Result<PathBuf, String> {
    let options: serde_json::Value = serde_json::from_str(options).map_err(|e| e.to_string())?;
    let directory = options
        .get("mailStorageDirectory")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if directory.is_empty() {
        return Ok(default.to_path_buf());
    }
    let path = PathBuf::from(directory);
    if !path.is_absolute() {
        return Err("Mail storage directory must be an absolute path".into());
    }
    Ok(path)
}

pub struct ProcessLock(File);

impl ProcessLock {
    pub fn try_at(database: &Path, purpose: &str) -> Result<Option<Self>, String> {
        let parent = database.parent().ok_or("Invalid mail database path")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let path = database.with_extension(format!("{purpose}.lock"));
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| format!("Open mailbox lock: {e}"))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self(file))),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(e)) => Err(format!("Lock mailbox: {e}")),
        }
    }

    pub fn access(database: &Path) -> Result<Self, String> {
        Self::access_cancellable(database, &tokio_util::sync::CancellationToken::new())
    }

    fn access_cancellable(
        database: &Path,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Self, String> {
        let start = Instant::now();
        loop {
            if cancel.is_cancelled() {
                return Err("BACKUP_CANCELLED".into());
            }
            if let Some(lock) = Self::try_at(database, "access")? {
                return Ok(lock);
            }
            if start.elapsed() >= Duration::from_secs(3) {
                return Err("Mail storage is busy in another instance (moving or taking a snapshot); retry shortly".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for ProcessLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub fn redirect_path(database: &Path) -> PathBuf {
    database.with_extension("redirect.json")
}

pub fn write_redirect(source: &Path, target: &Path) -> Result<(), String> {
    use std::io::Write;
    let mut file =
        tempfile::NamedTempFile::new_in(source.parent().unwrap()).map_err(|e| e.to_string())?;
    serde_json::to_writer(file.as_file_mut(), target).map_err(|e| e.to_string())?;
    file.as_file_mut().flush().map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(redirect_path(source))
        .map_err(|e| e.error.to_string())?;
    Ok(())
}

struct MailConnection {
    path: PathBuf,
    connection: Option<Connection>,
    initialized: bool,
    generation: Option<Vec<u8>>,
}

type InitializeSchema = fn(&Connection) -> rusqlite::Result<()>;

pub struct MailDatabase {
    connection: Mutex<MailConnection>,
    initialize_schema: InitializeSchema,
}

impl MailDatabase {
    /// Opening SQLite is deferred to a blocking worker, including first access.
    pub fn new(path: PathBuf, initialize_schema: InitializeSchema) -> Self {
        Self {
            connection: Mutex::new(MailConnection {
                path,
                connection: None,
                initialized: false,
                generation: None,
            }),
            initialize_schema,
        }
    }

    pub fn lock(&self) -> Result<MailGuard<'_>, String> {
        self.lock_cancellable(&tokio_util::sync::CancellationToken::new())
    }

    pub fn lock_cancellable(
        &self,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<MailGuard<'_>, String> {
        self.lock_inner(cancel, true)
    }

    /// Backups copy existing data without running migrations that inspect MIME
    /// objects, especially when the original-message category is excluded.
    pub fn lock_for_snapshot(
        &self,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<MailGuard<'_>, String> {
        self.lock_inner(cancel, false)
    }

    fn lock_inner(
        &self,
        cancel: &tokio_util::sync::CancellationToken,
        initialize: bool,
    ) -> Result<MailGuard<'_>, String> {
        let mut inner = loop {
            if cancel.is_cancelled() {
                return Err("BACKUP_CANCELLED".into());
            }
            match self.connection.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) => return Err(error.to_string()),
            }
        };
        // Migration updates the existing Connection while holding this guard.
        if let Some(connection) = inner.connection.as_ref() {
            inner.path = PathBuf::from(connection.path().ok_or("Mail storage has no disk path")?);
        }
        for _ in 0..32 {
            let lock = ProcessLock::access_cancellable(&inner.path, cancel)?;
            let redirect = redirect_path(&inner.path);
            if redirect.exists() {
                let target: PathBuf =
                    serde_json::from_slice(&fs::read(redirect).map_err(|e| e.to_string())?)
                        .map_err(|e| format!("Read mailbox relocation: {e}"))?;
                if !target.is_absolute() || target.file_name() != inner.path.file_name() {
                    return Err("Invalid mailbox relocation target".into());
                }
                // Close a cached connection before following the relocation.
                // Never recreate a stale source database after a move.
                inner.connection = None;
                inner.path = target;
                drop(lock);
                continue;
            }
            let generation = match fs::read(inner.path.with_extension("generation")) {
                Ok(value) => Some(value),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.to_string()),
            };
            if generation != inner.generation {
                inner.connection = None;
                inner.generation = generation;
            }
            if inner.connection.is_none() {
                let db = Connection::open(&inner.path)
                    .map_err(|e| format!("Open mail database: {e}"))?;
                db.busy_timeout(Duration::from_secs(3))
                    .map_err(|e| e.to_string())?;
                inner.connection = Some(db);
                inner.initialized = false;
            }
            if initialize && !inner.initialized {
                let db = inner.connection.as_ref().unwrap();
                let cancellation = cancel.clone();
                db.progress_handler(1_000, Some(move || cancellation.is_cancelled()))
                    .map_err(|e| e.to_string())?;
                let result = (self.initialize_schema)(db).map_err(|e| e.to_string());
                db.progress_handler(0, None::<fn() -> bool>)
                    .map_err(|e| e.to_string())?;
                if cancel.is_cancelled() {
                    return Err("BACKUP_CANCELLED".into());
                }
                result?;
                inner.initialized = true;
            }
            return Ok(MailGuard {
                inner,
                _process: lock,
            });
        }
        Err("Mailbox relocation chain is too long or contains a cycle".into())
    }
}

pub struct MailGuard<'a> {
    inner: MutexGuard<'a, MailConnection>,
    _process: ProcessLock,
}
impl Deref for MailGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.inner.connection.as_ref().unwrap()
    }
}
impl DerefMut for MailGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.inner.connection.as_mut().unwrap()
    }
}

pub fn mail_db_file_stem(account_id: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut cleaned = account_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if cleaned.is_empty() {
        cleaned = "mail".into();
    }
    cleaned = cleaned.chars().take(80).collect();

    let digest = Sha256::digest(account_id.as_bytes());
    let digest_hex = hex::encode(digest);
    format!("{cleaned}-{}", &digest_hex[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_leaves_schema_initialization_for_the_first_operational_access() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cache").join("mail.db");
        let database = MailDatabase::new(path.clone(), |connection| {
            connection.execute_batch("CREATE TABLE mailbox (value TEXT)")
        });
        assert!(!path.parent().unwrap().exists());
        let cancel = tokio_util::sync::CancellationToken::new();
        {
            let snapshot = database.lock_for_snapshot(&cancel).unwrap();
            assert_eq!(
                snapshot
                    .query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0,
            );
        }

        database
            .lock()
            .unwrap()
            .execute("INSERT INTO mailbox VALUES ('retained')", [])
            .unwrap();
        let reopened = database.lock().unwrap();
        let value: String = reopened
            .query_row("SELECT value FROM mailbox", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "retained");
    }
}
