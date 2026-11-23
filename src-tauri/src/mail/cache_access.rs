use std::path::PathBuf;

use super::*;

pub use taomni_mail_engine::cache::init_mail_tables;

pub(super) fn with_mail_db<T>(
    state: &State<'_, AppState>,
    account_id: &str,
    f: impl FnOnce(&Connection) -> SqlResult<T>,
) -> Result<T, String> {
    let db = state.mail_db(account_id)?;
    let db = db.lock().map_err(|e| e.to_string())?;
    f(&db).map_err(|e| e.to_string())
}

/// SQLite and its mutex must not occupy Tokio's workers, which also carry
/// terminal I/O and proxy forwarding. The closure owns only this operation's
/// inputs; the cache lock is never held across a network request.
pub(super) async fn with_mail_db_async<T: Send + 'static>(
    state: &State<'_, AppState>,
    account_id: &str,
    f: impl FnOnce(&Connection, &str) -> SqlResult<T> + Send + 'static,
) -> Result<T, String> {
    let db = state.mail_db(account_id)?;
    mail_db_task(db, account_id.to_string(), f).await
}

/// Locate/open an immutable original under the DB lock, but perform all file
/// work and MIME decoding after releasing it on the blocking pool.
pub(super) async fn with_mail_original<T: Send + 'static>(
    state: &State<'_, AppState>,
    account_id: &str,
    locate: impl FnOnce(&Connection, &str) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    with_mail_db_async(state, account_id, move |db, account| {
        locate(db, account).map_err(storage::as_sql_error)
    })
    .await
}

pub(super) async fn decode_mail_original<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("Saved email task failed: {e}"))?
}

pub(super) async fn mail_db_task<T: Send + 'static>(
    db: crate::state::MailDbHandle,
    account_id: String,
    f: impl FnOnce(&Connection, &str) -> SqlResult<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || {
        let db = db.lock().map_err(|e| e.to_string())?;
        f(&db, &account_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("mail cache task failed: {e}"))?
}

/// Resolve relocation before sending the account cache to its signed writer.
pub(super) fn canonical_cache_database(
    cache: &crate::state::MailDbHandle,
) -> Result<PathBuf, String> {
    let db = cache.lock()?;
    Path::new(db.path().ok_or("Mail storage has no disk path")?)
        .canonicalize()
        .map_err(|error| error.to_string())
}
