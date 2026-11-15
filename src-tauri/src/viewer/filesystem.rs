use super::paths::{absolute, display, io_error};
use super::{BytesData, FileStat, HARD_BYTES};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub(super) fn mtime(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(super) fn limit(requested: Option<u64>, default: u64, hard: u64) -> Result<u64, String> {
    let limit = requested.unwrap_or(default);
    if limit == 0 || limit > hard {
        return Err(format!(
            "too_large: Read budget must be between 1 and {hard} bytes"
        ));
    }
    Ok(limit)
}

pub(super) fn open_regular(path: &str) -> Result<(PathBuf, File, fs::Metadata), String> {
    let path = absolute(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options
        .open(&path)
        .map_err(|error| io_error("open file", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error("stat file", error))?;
    if !metadata.is_file() {
        return Err("permission: Viewer can only read regular files".into());
    }
    Ok((path, file, metadata))
}

/// The extra byte detects growth/truncation without unbounded fs::read.
pub(super) fn bounded_read(file: &mut File, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("read file", error))?;
    Ok(bytes)
}

pub(super) fn mime(path: &Path, sample: &[u8]) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let known = match extension.as_str() {
        "htm" | "html" => Some("text/html"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "css" => Some("text/css"),
        "js" | "mjs" => Some("text/javascript"),
        "json" | "map" => Some("application/json"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "xml" => Some("application/xml"),
        "txt" | "log" | "ini" | "conf" | "env" | "yaml" | "yml" | "toml" => Some("text/plain"),
        "md" | "markdown" => Some("text/markdown"),
        "csv" => Some("text/csv"),
        "pdf" => Some("application/pdf"),
        "wasm" => Some("application/wasm"),
        _ => None,
    };
    known.map(str::to_string).unwrap_or_else(|| {
        tauri::utils::mime_type::MimeType::parse_with_fallback(
            sample,
            &display(path),
            tauri::utils::mime_type::MimeType::OctetStream,
        )
    })
}

pub(crate) fn stat(path: &str) -> Result<FileStat, String> {
    let path = absolute(path)?;
    let metadata = fs::metadata(&path).map_err(|error| io_error("stat file", error))?;
    Ok(FileStat {
        path: display(&path),
        size: metadata.len(),
        mtime: mtime(&metadata),
        mime: mime(&path, &[]),
        is_file: metadata.is_file(),
    })
}

pub(crate) fn read_bytes(path: &str, max_bytes: Option<u64>) -> Result<BytesData, String> {
    let limit = limit(max_bytes, HARD_BYTES, HARD_BYTES)?;
    let (path, mut file, metadata) = open_regular(path)?;
    if metadata.len() > limit {
        return Err(format!(
            "too_large: File is {} bytes; limit is {limit}",
            metadata.len()
        ));
    }
    let bytes = bounded_read(&mut file, limit)?;
    if bytes.len() as u64 > limit {
        return Err("too_large: File grew beyond the read budget".into());
    }
    Ok(BytesData {
        mime: mime(&path, &bytes),
        size: bytes.len() as u64,
        bytes,
    })
}
