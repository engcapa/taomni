//! Keep the selection alive for confirmation without keeping the real cache open.

use std::{
    collections::HashMap,
    ffi::CStr,
    fs,
    io::ErrorKind,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
};
use taomni_mail_api::archive_index::{
    ArchiveIndexAction, ArchiveIndexRequest, ArchiveIndexSource, ArchiveSelection, CleanupPreview,
};
use taomni_mail_engine::storage::{query, remove_entries_with, scan};
use taomni_plugin_api::{ErrorCode, RpcError};

use super::{account_cache::lock_account_cache, archive_index::encode, store::connect};

const PREVIEW_TTL: Duration = Duration::from_secs(600);
const EXPIRED: &str =
    "The cleanup preview expired or its messages changed. Review the selection again";

#[derive(Default)]
pub(super) struct ArchivePreviews(Mutex<HashMap<String, Preview>>);

struct Preview {
    token: String,
    expires: Instant,
    cache: CacheVersion,
    snapshot: Connection,
}

#[derive(PartialEq)]
struct CacheVersion {
    database: PathBuf,
    generation: Option<Vec<u8>>,
}

impl CacheVersion {
    fn read(database: PathBuf) -> Result<Self, String> {
        let generation = match fs::read(database.with_extension("generation")) {
            Ok(value) => Some(value),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            database,
            generation,
        })
    }
}

impl ArchivePreviews {
    pub(super) fn run(
        &self,
        request: ArchiveIndexRequest,
        check: &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Vec<u8>, RpcError> {
        let ArchiveIndexSource::AccountCache { database } = request.source else {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        };
        let account = &request.account_id;
        check()?;
        let _access = lock_account_cache(&database, account)
            .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
        check()?;
        let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let check = || check().map_err(|error| error.message);
        match request.action {
            ArchiveIndexAction::Preview { selection } => {
                encode(self.preview(&db, database, account, &selection, &check))
            }
            ArchiveIndexAction::Cleanup { token } => {
                encode(self.cleanup(&mut db, database, account, &token, &check))
            }
            ArchiveIndexAction::Remove { entries } => encode((|| {
                scan::pause(&db, account).map_err(|error| error.to_string())?;
                remove_entries_with(&db, account, &entries, check)
            })()),
            _ => Err(RpcError::from_code(ErrorCode::InvalidParams)),
        }
    }

    fn preview(
        &self,
        db: &Connection,
        database: PathBuf,
        account: &str,
        selection: &ArchiveSelection,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<CleanupPreview, String> {
        let cache = CacheVersion::read(database)?;
        let preview = query::preview(db, account, selection)?;
        // An empty SQLite filename creates a private temporary database. It can
        // spill to disk for large selections and SQLite removes it on close.
        let mut snapshot = Connection::open("").map_err(|error| error.to_string())?;
        copy_snapshot(db, c"temp", &mut snapshot, c"main", check)?;
        let mut previews = self.0.lock().map_err(|error| error.to_string())?;
        let now = Instant::now();
        previews.retain(|_, preview| preview.expires > now);
        previews.insert(
            account.to_owned(),
            Preview {
                token: preview.token.clone(),
                expires: now + PREVIEW_TTL,
                cache,
                snapshot,
            },
        );
        Ok(preview)
    }

    fn cleanup(
        &self,
        db: &mut Connection,
        database: PathBuf,
        account: &str,
        token: &str,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<u64, String> {
        let cache = CacheVersion::read(database)?;
        {
            let mut previews = self.0.lock().map_err(|error| error.to_string())?;
            previews.retain(|_, preview| preview.expires > Instant::now());
            let preview = previews
                .get(account)
                .filter(|preview| preview.token == token && preview.cache == cache)
                .ok_or(EXPIRED)?;
            // Instantiate SQLite's temporary schema before restoring it.
            db.execute_batch("CREATE TEMP TABLE archive_snapshot_init (unused INTEGER)")
                .map_err(|error| error.to_string())?;
            copy_snapshot(&preview.snapshot, c"main", db, c"temp", check)?;
        }
        let removed = query::remove_preview_with(db, account, token, check)?;
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .remove(account);
        Ok(removed)
    }
}

fn copy_snapshot(
    from: &Connection,
    from_name: &CStr,
    to: &mut Connection,
    to_name: &CStr,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let backup =
        Backup::new_with_names(from, from_name, to, to_name).map_err(|error| error.to_string())?;
    loop {
        check()?;
        match backup.step(128).map_err(|error| error.to_string())? {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            _ => return Err("Mail archive preview snapshot is busy. Please retry".into()),
        }
    }
}

#[cfg(test)]
mod tests;
