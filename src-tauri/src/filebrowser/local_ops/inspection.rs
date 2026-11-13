use super::model::{LocalProperties, OpError, OpResult, PreviewBytes, PreviewText};
use super::operation::Operation;
use crate::filebrowser::local;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TEXT_LIMIT: usize = 256 * 1024;
const IMAGE_LIMIT: u64 = 20 * 1024 * 1024;
const PROPERTIES_ENTRY_LIMIT: u64 = 100_000;
const PROPERTIES_TIME_LIMIT: Duration = Duration::from_secs(2);

fn seconds(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs().min(i64::MAX as u64) as i64)
}

pub(super) fn properties(path: &Path, operation: &mut Operation) -> OpResult<LocalProperties> {
    properties_bounded(
        path,
        operation,
        PROPERTIES_ENTRY_LIMIT,
        PROPERTIES_TIME_LIMIT,
    )
}

pub(super) fn properties_bounded(
    path: &Path,
    operation: &mut Operation,
    limit: u64,
    time_limit: Duration,
) -> OpResult<LocalProperties> {
    operation.check()?;
    let entry = local::stat(path).map_err(|e| OpError::new("stat_failed", e))?;
    let meta = fs::symlink_metadata(path).map_err(|e| OpError::io("stat", path, e))?;
    let mut result = LocalProperties {
        path: entry.path,
        name: entry.name,
        file_type: entry.file_type,
        size: if meta.is_dir() { 0 } else { meta.len() },
        item_count: 0,
        truncated: false,
        mtime: entry.mtime,
        created_at: meta.created().ok().and_then(seconds),
        mode: entry.mode,
        owner: entry.owner,
        group: entry.group,
        symlink_target: entry.symlink_target,
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        result.owner = Some(meta.uid().to_string());
        result.group = Some(meta.gid().to_string());
    }
    if !meta.is_dir() {
        return Ok(result);
    }
    let start = Instant::now();
    let mut stack =
        vec![fs::read_dir(path).map_err(|e| OpError::io("read folder properties", path, e))?];
    while let Some(reader) = stack.last_mut() {
        operation.check()?;
        if result.item_count >= limit || start.elapsed() >= time_limit {
            result.truncated = true;
            break;
        }
        let Some(item) = reader.next() else {
            stack.pop();
            continue;
        };
        let item = match item {
            Ok(item) => item,
            Err(_) => {
                result.truncated = true;
                continue;
            }
        };
        let item_path = item.path();
        result.item_count += 1;
        let metadata = match fs::symlink_metadata(&item_path) {
            Ok(metadata) => metadata,
            Err(_) => {
                result.truncated = true;
                continue;
            }
        };
        if metadata.is_dir() {
            if stack.len() >= 256 {
                result.truncated = true;
            } else {
                match fs::read_dir(&item_path) {
                    Ok(reader) => stack.push(reader),
                    Err(_) => result.truncated = true,
                }
            }
        } else if metadata.is_file() || metadata.file_type().is_symlink() {
            result.size = result.size.saturating_add(metadata.len());
        }
        operation.advance(&item_path, 0, 1)?;
    }
    Ok(result)
}

fn open_regular(path: &Path) -> OpResult<fs::File> {
    let meta = fs::metadata(path).map_err(|e| OpError::io("stat preview", path, e))?;
    if !meta.is_file() {
        return Err(OpError::new(
            "unsupported_type",
            "Preview only reads regular files",
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    // An external rename must not turn a preview into a blocking FIFO read.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|e| OpError::io("open preview", path, e))?;
    if !file
        .metadata()
        .map_err(|e| OpError::io("stat open preview", path, e))?
        .is_file()
    {
        return Err(OpError::new(
            "unsupported_type",
            "Preview only reads regular files",
        ));
    }
    Ok(file)
}

pub(super) fn preview_text(path: &Path) -> OpResult<PreviewText> {
    let file = open_regular(path)?;
    let mut bytes = Vec::new();
    file.take((TEXT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| OpError::io("read preview", path, e))?;
    let truncated = bytes.len() > TEXT_LIMIT;
    bytes.truncate(TEXT_LIMIT);
    // NULs and non-whitespace control bytes flag binary content even for a
    // misleading .txt extension. Invalid UTF-8 is not lossy-decoded into text.
    let control_count = bytes
        .iter()
        .filter(|&&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0c))
        .count();
    let mut binary = bytes.contains(&0) || control_count > bytes.len() / 100;
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_string(),
        // A valid multibyte character can straddle the fixed byte boundary.
        Err(error) if truncated && error.error_len().is_none() => {
            String::from_utf8(bytes[..error.valid_up_to()].to_vec()).unwrap_or_default()
        }
        Err(_) => {
            binary = true;
            String::new()
        }
    };
    Ok(PreviewText {
        text: if binary { String::new() } else { text },
        truncated,
        binary,
    })
}

pub(super) fn preview_bytes(path: &Path, max_bytes: u64) -> OpResult<PreviewBytes> {
    let limit = max_bytes.min(IMAGE_LIMIT);
    let file = open_regular(path)?;
    let length = file
        .metadata()
        .map_err(|e| OpError::io("stat preview", path, e))?
        .len();
    if length > limit {
        return Err(OpError::new(
            "too_large",
            format!("Image exceeds the {} byte preview limit", limit),
        ));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    // Read bound is enforced even if another process grows the file after stat.
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| OpError::io("read preview", path, e))?;
    if bytes.len() as u64 > limit {
        return Err(OpError::new(
            "too_large",
            "Image grew beyond the preview limit",
        ));
    }
    let mime = image_mime(path, &bytes)
        .ok_or_else(|| OpError::new("unsupported_type", "File is not a supported image"))?;
    Ok(PreviewBytes {
        bytes,
        mime: mime.into(),
    })
}

fn image_mime(path: &Path, bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some("image/tiff")
    } else if bytes.starts_with(b"\0\0\x01\0") {
        Some("image/x-icon")
    } else if bytes.get(4..8) == Some(b"ftyp")
        && bytes
            .get(8..12)
            .is_some_and(|b| b == b"avif" || b == b"avis")
    {
        Some("image/avif")
    } else if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
        && std::str::from_utf8(bytes).is_ok_and(|text| text.contains("<svg"))
    {
        Some("image/svg+xml")
    } else {
        None
    }
}
