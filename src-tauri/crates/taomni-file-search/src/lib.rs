//! On-demand global filename search. The application owns no persistent index.
mod locations;
mod matching;
mod providers;
mod scan;
#[cfg(windows)]
mod windows_index;
#[cfg(not(windows))]
use providers as platform;
#[cfg(windows)]
use windows_index as platform;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Plocate,
    Spotlight,
    WindowsSearch,
    BoundedScan,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub entries: Vec<SearchEntry>,
    pub provider: Provider,
    pub truncated: bool,
    pub scanned_roots: Vec<String>,
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("cancelled: File search cancelled".into())
    } else {
        Ok(())
    }
}

fn validate(query: &str) -> Result<&str, String> {
    let query = query.trim();
    if query.len() > 384
        || !(2..=96).contains(&query.chars().count())
        || query.chars().any(char::is_control)
    {
        return Err("invalid_query: Enter 2–96 filename characters".into());
    }
    Ok(query)
}

pub async fn search(
    query: &str,
    context_root: Option<PathBuf>,
    cancelled: Arc<AtomicBool>,
) -> Result<SearchResults, String> {
    static CAPACITY: Semaphore = Semaphore::const_new(2);
    static WORKER: Semaphore = Semaphore::const_new(1);
    let query = validate(query)?.to_owned();
    check_cancelled(&cancelled)?;
    let busy = || "busy: A file search is already running".to_owned();
    let _capacity = CAPACITY.try_acquire().map_err(|_| busy())?;
    // Allow a just-cancelled request to unwind before accepting a replacement.
    let permit = tokio::time::timeout(Duration::from_millis(240), WORKER.acquire())
        .await
        .map_err(|_| busy())?
        .map_err(|_| busy())?;
    let indexed = platform::lookup(&query, &cancelled).await?;
    let roots = context_root.into_iter().chain(dirs::home_dir()).collect();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        scan::finish(&query, indexed, roots, &cancelled)
    })
    .await
    .map_err(|e| format!("worker_error: {e}"))?
}

#[cfg(test)]
mod tests;
