//! The installed sample uses the official SDK and a real lazy SQLite store.
//! Legacy stateless fault fixtures retain their synchronous main entry.
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use taomni_plugin_api::{ErrorCode, RpcError, services::*};
use taomni_plugin_sdk::{
    HostConfig, Operation, PluginHandler, SnapshotExport, SnapshotProvider, serve_stdio_with,
};

pub fn commands() -> BTreeSet<String> {
    [
        super::PING_METHOD,
        super::CRASH_METHOD,
        super::HANG_METHOD,
        super::ENABLE_METHOD,
        super::DISABLE_METHOD,
        "hello/write",
        "hello/read",
        SNAPSHOT_PREPARE_METHOD,
        SNAPSHOT_METHOD,
        SNAPSHOT_RELEASE_METHOD,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

pub fn serve_profiled() -> io::Result<()> {
    serve_stdio_with(
        HostConfig {
            plugin_id: super::PLUGIN_ID.into(),
            plugin_version: super::PLUGIN_VERSION.into(),
            commands: commands(),
            permissions: BTreeSet::new(),
            required_services: ServiceCapabilities::default(),
            optional_services: ServiceCapabilities::default(),
            operation_timeout: Duration::from_secs(30),
            snapshot_timeout: Duration::from_secs(300),
        },
        |storage| {
            let storage = storage.ok_or_else(|| io::Error::other("profile ownership required"))?;
            let root = storage.root().path().join("plugins/hello-plugin/data");
            let store =
                Store::open(root).map_err(|_| io::Error::other("hello store unavailable"))?;
            Ok(Arc::new(Handler {
                enabled: AtomicBool::new(false),
                store: Arc::new(store),
            }))
        },
    )
}

struct Store {
    root: PathBuf,
    database: Mutex<Option<rusqlite::Connection>>,
    frozen: AtomicBool,
}

struct Handler {
    enabled: AtomicBool,
    store: Arc<Store>,
}

fn failed(_: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "HELLO_DATA_FAILED")
}

impl PluginHandler for Handler {
    fn snapshot_provider(&self) -> Option<Arc<dyn SnapshotProvider>> {
        Some(self.store.clone())
    }

    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, RpcError> {
        operation.check_current()?;
        match method {
            super::ENABLE_METHOD | super::DISABLE_METHOD => {
                let enabled = method == super::ENABLE_METHOD;
                self.enabled.store(enabled, Ordering::Release);
                Ok(serde_json::json!({"enabled":enabled}))
            }
            super::PING_METHOD => Ok(serde_json::json!({"pluginId":super::PLUGIN_ID,
                "version":super::PLUGIN_VERSION,"enabled":self.enabled.load(Ordering::Acquire)})),
            super::CRASH_METHOD => std::process::exit(70),
            super::HANG_METHOD => {
                std::thread::sleep(super::HelloPlugin::hang_duration());
                operation.check_current()?;
                Ok(serde_json::Value::Null)
            }
            "hello/write" | "hello/read" => self.store.business(operation, method, params),
            _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
    }
}

impl Store {
    fn open(root: PathBuf) -> Result<Self, RpcError> {
        let path = root.join("hello.sqlite");
        let database = match fs::symlink_metadata(&path) {
            Ok(_) => Some(Self::open_database(&path, false)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(failed(error)),
        };
        // Resume ownership of an existing store at normal startup, so backup
        // never needs a read/write command to initialize its connection.
        // A profile that has never used the sample still creates no database.
        Ok(Self {
            root,
            database: Mutex::new(database),
            frozen: AtomicBool::new(false),
        })
    }

    fn open_database(path: &Path, create: bool) -> Result<rusqlite::Connection, RpcError> {
        let root = path.parent().ok_or_else(|| failed("missing parent"))?;
        if create {
            fs::create_dir_all(root).map_err(failed)?;
        }
        ordinary_directory(root)?;
        match fs::symlink_metadata(path) {
            Ok(_) => ordinary_file(path)?,
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(failed(error)),
        }
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW
            | if create {
                rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            } else {
                rusqlite::OpenFlags::empty()
            };
        let db = rusqlite::Connection::open_with_flags(path, flags).map_err(failed)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .map_err(failed)?;
        if create {
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
            )
            .map_err(failed)?;
        }
        db.prepare("SELECT value FROM entries ORDER BY id")
            .map_err(failed)?;
        Ok(db)
    }

    fn business(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, RpcError> {
        if self.frozen.load(Ordering::Acquire) {
            return Err(failed("snapshot busy"));
        }
        let mut database = self.database.lock().map_err(failed)?;
        let path = self.root.join("hello.sqlite");
        let write = method == "hello/write";
        if database.is_none() && (write || path.try_exists().map_err(failed)?) {
            *database = Some(Self::open_database(&path, write)?);
        }
        if write {
            let value = params
                .as_ref()
                .and_then(|params| params.get("value"))
                .and_then(|value| value.as_str())
                .filter(|value| value.len() <= 4096)
                .ok_or_else(|| RpcError::from_code(ErrorCode::InvalidParams))?;
            operation.check_current()?;
            database
                .as_ref()
                .ok_or_else(|| failed("missing store"))?
                .execute("INSERT INTO entries(value) VALUES (?)", [value])
                .map_err(failed)?;
        }
        let rows = match database.as_ref() {
            Some(db) => db
                .prepare("SELECT value FROM entries ORDER BY id")
                .map_err(failed)?
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(failed)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(failed)?,
            None => Vec::new(),
        };
        operation.check_current()?;
        Ok(serde_json::json!({"values":rows}))
    }
}

impl SnapshotProvider for Store {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()?;
        if self.frozen.swap(true, Ordering::AcqRel) {
            return Err(failed("already frozen"));
        }
        // The SDK serial actor has drained business commands. This sample has
        // no background writers; its gate stays closed between wire calls.
        drop(self.database.lock().map_err(failed)?);
        Ok(())
    }

    fn export(
        &self,
        destination: &mut SnapshotExport,
        operation: &Operation,
    ) -> Result<(), RpcError> {
        if !self.frozen.load(Ordering::Acquire) {
            return Err(failed("not frozen"));
        }
        let files: Vec<_> = destination.allowed_paths().map(str::to_owned).collect();
        for file in files {
            operation.check_current()?;
            if file == "hello.sqlite" {
                let database = self.database.lock().map_err(failed)?;
                let db = database
                    .as_ref()
                    .ok_or_else(|| failed("store must be opened by a business command"))?;
                destination.sqlite(&file, db)?;
            } else {
                let path = self.root.join(&file);
                ordinary_file(&path)?;
                destination.file(&file, File::open(&path).map_err(failed)?)?;
            }
        }
        Ok(())
    }

    fn resume(&self) {
        self.frozen.store(false, Ordering::Release);
    }
}

fn ordinary_directory(path: &Path) -> Result<(), RpcError> {
    if fs::canonicalize(path).map_err(failed)? != path {
        return Err(failed("linked data directory"));
    }
    Ok(())
}

fn ordinary_file(path: &Path) -> Result<(), RpcError> {
    ordinary_directory(path.parent().ok_or_else(|| failed("missing parent"))?)?;
    let metadata = fs::symlink_metadata(path).map_err(failed)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(failed("linked data"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(failed("reparse data"));
        }
    }
    Ok(())
}
