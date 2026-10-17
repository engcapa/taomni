//! Short account-scoped OS locks protect SQLite references and immutable files
//! across application processes. Network and MIME work never holds this lock.
use rusqlite::Connection;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

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
        let start = Instant::now();
        loop {
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
    generation: Option<Vec<u8>>,
}

pub struct MailDatabase(Mutex<MailConnection>);

impl MailDatabase {
    /// Opening SQLite is deferred to a blocking worker, including first access.
    pub fn new(path: PathBuf) -> Self {
        Self(Mutex::new(MailConnection {
            path,
            connection: None,
            generation: None,
        }))
    }

    pub fn lock(&self) -> Result<MailGuard<'_>, String> {
        let mut inner = self.0.lock().map_err(|e| e.to_string())?;
        // Migration updates the existing Connection while holding this guard.
        if let Some(connection) = inner.connection.as_ref() {
            inner.path = PathBuf::from(connection.path().ok_or("Mail storage has no disk path")?);
        }
        for _ in 0..32 {
            let lock = ProcessLock::access(&inner.path)?;
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
                super::init_mail_tables(&db).map_err(|e| e.to_string())?;
                inner.connection = Some(db);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::process::{Child, Command, Stdio};

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn child(root: &Path, mode: &str) -> ChildGuard {
        ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "mail::coordination::tests::mail_storage_child"])
                .env("TAOMNI_MAIL_PROCESS_TEST", root)
                .env("TAOMNI_MAIL_PROCESS_MODE", mode)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
    fn wait(root: &Path, child: &mut ChildGuard, name: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.join(name).exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "mail child exited early"
            );
            assert!(Instant::now() < deadline, "mail child timed out: {name}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn database(root: &Path) -> PathBuf {
        root.join(format!("{}.db", crate::state::mail_db_file_stem("qa")))
    }
    #[test]
    fn mail_storage_child() {
        let Some(root) = std::env::var_os("TAOMNI_MAIL_PROCESS_TEST") else {
            return;
        };
        let root = Path::new(&root);
        let db = MailDatabase::new(database(root));
        let mode = std::env::var("TAOMNI_MAIL_PROCESS_MODE").unwrap();
        let lease = if mode == "worker" {
            Some(
                ProcessLock::try_at(&database(root), "archive")
                    .unwrap()
                    .unwrap(),
            )
        } else {
            None
        };
        drop(db.lock().unwrap()); // Cache an old SQLite connection in this process.
        fs::write(root.join("ready"), b"ok").unwrap();
        std::io::stdin().read_exact(&mut [0]).unwrap();
        if mode == "relocate" {
            let connection = db.lock().unwrap();
            let raw = super::super::storage::read(&connection, "qa", "INBOX", 1)
                .unwrap()
                .unwrap();
            assert_eq!(raw, b"Subject: original\r\n\r\nbody");
            connection
                .execute(
                    "INSERT INTO mail_archive_preferences(account_id,paused) VALUES('child',1)",
                    [],
                )
                .unwrap();
            assert_eq!(
                Path::new(connection.path().unwrap()).parent().unwrap(),
                root.join("new")
            );
        }
        drop(lease);
        fs::write(root.join("done"), b"ok").unwrap();
    }
    #[test]
    fn worker_ownership_is_per_account_and_released_after_process_crash() {
        let root = tempfile::tempdir().unwrap();
        let mut child = child(root.path(), "worker");
        wait(root.path(), &mut child, "ready");
        assert!(
            ProcessLock::try_at(&database(root.path()), "archive")
                .unwrap()
                .is_none()
        );
        // Reading and other accounts continue while this account downloads.
        drop(MailDatabase::new(database(root.path())).lock().unwrap());
        let _other = ProcessLock::try_at(&root.path().join("second.db"), "archive")
            .unwrap()
            .unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(
            ProcessLock::try_at(&database(root.path()), "archive")
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn another_process_follows_relocation_and_writes_only_to_the_new_database() {
        let root = tempfile::tempdir().unwrap();
        let db = MailDatabase::new(database(root.path()));
        {
            let conn = db.lock().unwrap();
            super::super::storage::store(
                &conn,
                "qa",
                "INBOX",
                1,
                1,
                &b"Subject: original\r\n\r\nbody"[..],
            )
            .unwrap();
        }
        let mut child = child(root.path(), "relocate");
        wait(root.path(), &mut child, "ready");
        super::super::storage::relocate(
            &mut db.lock().unwrap(),
            "qa",
            &root.path().join("new"),
            || Ok(()),
        )
        .unwrap();
        child.0.stdin.as_mut().unwrap().write_all(b"x").unwrap();
        wait(root.path(), &mut child, "done");
        assert!(child.0.wait().unwrap().success());
        let exists: bool = db
            .lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mail_archive_preferences WHERE account_id='child')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(exists);
        // An instance starting with stale session settings follows the same link.
        let fresh = MailDatabase::new(database(root.path()));
        let fresh_path = fresh.lock().unwrap().path().unwrap().to_string();
        let current_path = db.lock().unwrap().path().unwrap().to_string();
        assert_eq!(fresh_path, current_path);
    }
}
