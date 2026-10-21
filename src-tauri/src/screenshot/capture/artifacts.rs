use anyhow::Context;
use image::RgbaImage;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotFile {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

// ---------------------------------------------------------------------------
// Temp artifacts
// ---------------------------------------------------------------------------

/// Stale per-process artifact directories older than this are purged at
/// startup (they belong to crashed or long-gone instances).
pub(super) const STALE_ARTIFACT_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub(super) static TRACKED: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();

pub(super) fn tracked() -> &'static Mutex<Vec<PathBuf>> {
    TRACKED.get_or_init(|| Mutex::new(Vec::new()))
}

pub(super) fn artifact_root() -> PathBuf {
    std::env::temp_dir().join("taomni-screenshot")
}

/// Per-process artifact directory (several app instances may run at once,
/// e.g. an installed app next to a QA build).
pub fn artifact_dir() -> anyhow::Result<PathBuf> {
    let dir = artifact_root().join(std::process::id().to_string());
    std::fs::create_dir_all(&dir).context("create screenshot temp dir")?;
    Ok(dir)
}

/// New temp artifact path. Tracked files are deleted when the capture
/// session ends (see [`purge_tracked`]).
pub fn temp_artifact_path(prefix: &str, ext: &str) -> anyhow::Result<PathBuf> {
    let path = untracked_artifact_path(prefix, ext)?;
    tracked().lock().unwrap().push(path.clone());
    Ok(path)
}

/// New temp artifact path owned by the caller (pinned images).
pub fn untracked_artifact_path(prefix: &str, ext: &str) -> anyhow::Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(artifact_dir()?.join(format!("{prefix}-{nanos}.{ext}")))
}

/// Delete every tracked artifact of the finished capture session.
pub fn purge_tracked() {
    let files = std::mem::take(&mut *tracked().lock().unwrap());
    for file in files {
        let _ = std::fs::remove_file(file);
    }
}

/// Recovery assumes ownership before the screenshot session can purge files.
pub(in crate::screenshot) fn untrack_artifact(path: &Path) {
    tracked().lock().unwrap().retain(|entry| entry != path);
}

/// Startup cleanup: remove this process's leftovers and stale directories of
/// other instances. Directories of live instances are younger than the stale
/// age and survive.
pub fn purge_stale_artifacts() {
    let root = artifact_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let own = std::process::id().to_string();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_own = entry.file_name().to_string_lossy() == own;
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_ARTIFACT_AGE);
        if is_own || stale {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Validate that `path` is an existing file inside this process's artifact
/// directory. Every command that reads a caller-supplied path goes through
/// this, so the webview cannot use them to read or copy arbitrary files.
pub fn ensure_artifact_path(path: &str) -> anyhow::Result<PathBuf> {
    let dir = artifact_dir()?
        .canonicalize()
        .context("resolve screenshot temp dir")?;
    let file = Path::new(path)
        .canonicalize()
        .with_context(|| format!("screenshot file not found: {path}"))?;
    if !file.starts_with(&dir) || !file.is_file() {
        anyhow::bail!("path is not a screenshot artifact: {path}");
    }
    Ok(file)
}

pub fn save_png(image: &RgbaImage, prefix: &str) -> anyhow::Result<(PathBuf, u32, u32)> {
    let path = temp_artifact_path(prefix, "png")?;
    image.save(&path).context("save screenshot png")?;
    Ok((path, image.width(), image.height()))
}
