use crate::rdp::session::LocalClipboardFile;
use crate::rdp::session::MAX_CLIPBOARD_FILE_BYTES;
use crate::rdp::session::MAX_CLIPBOARD_FILE_ITEMS;
use crate::rdp::session::MAX_CLIPBOARD_TOTAL_BYTES;
use crate::rdp::session::display;
use ironrdp::cliprdr::pdu::ClipboardFileAttributes;
use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::path::PathBuf;

pub(in crate::rdp::session) fn collect_local_clipboard_files(
    paths: &[String],
) -> Result<Vec<LocalClipboardFile>, String> {
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    for raw in paths {
        if raw.trim().is_empty() {
            continue;
        }
        let path = PathBuf::from(raw);
        let path = path
            .canonicalize()
            .map_err(|e| format!("canonicalize '{}': {}", raw, e))?;
        let root = path.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
        collect_clipboard_path(&root, &path, &mut files, &mut total_bytes)?;
        if files.len() > MAX_CLIPBOARD_FILE_ITEMS {
            return Err(format!(
                "file clipboard contains more than {} items",
                MAX_CLIPBOARD_FILE_ITEMS
            ));
        }
    }
    Ok(files)
}

pub(in crate::rdp::session) fn collect_clipboard_path(
    root: &Path,
    path: &Path,
    out: &mut Vec<LocalClipboardFile>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("metadata '{}': {}", path.display(), e))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "clipboard path '{}' is a symbolic link; links are not transferred",
            path.display()
        ));
    }
    let is_directory = metadata.is_dir();
    if !is_directory {
        if metadata.len() > MAX_CLIPBOARD_FILE_BYTES {
            return Err(format!(
                "clipboard file '{}' exceeds the {} MiB per-file quota",
                path.display(),
                MAX_CLIPBOARD_FILE_BYTES / (1024 * 1024)
            ));
        }
        *total_bytes = total_bytes.saturating_add(metadata.len());
        if *total_bytes > MAX_CLIPBOARD_TOTAL_BYTES {
            return Err(format!(
                "file clipboard exceeds the {} MiB total quota",
                MAX_CLIPBOARD_TOTAL_BYTES / (1024 * 1024)
            ));
        }
    }
    let name = clipboard_relative_name(root, path)?;
    out.push(LocalClipboardFile {
        path: path.to_path_buf(),
        name,
        size: if is_directory { 0 } else { metadata.len() },
        is_directory,
        attributes: if is_directory {
            ClipboardFileAttributes::DIRECTORY
        } else {
            ClipboardFileAttributes::NORMAL
        },
    });

    if is_directory {
        let mut entries = fs::read_dir(path)
            .map_err(|e| format!("read directory '{}': {}", path.display(), e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read directory '{}': {}", path.display(), e))?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            collect_clipboard_path(root, &entry.path(), out, total_bytes)?;
            if out.len() > MAX_CLIPBOARD_FILE_ITEMS {
                return Err(format!(
                    "file clipboard contains more than {} items",
                    MAX_CLIPBOARD_FILE_ITEMS
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn clipboard_relative_name(root: &Path, path: &Path) -> Result<String, String> {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let name = rel
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("\\");
    if name.is_empty() {
        return Err(format!(
            "clipboard path '{}' has no file name",
            path.display()
        ));
    }
    if name.encode_utf16().count() >= 260 {
        return Err(format!(
            "clipboard file name '{}' exceeds 259 UTF-16 code units",
            name
        ));
    }
    Ok(name)
}

pub(crate) fn read_clipboard_file_range(
    path: &Path,
    position: u64,
    requested_size: u32,
) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|e| format!("open '{}': {}", path.display(), e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| format!("seek '{}': {}", path.display(), e))?;
    let max_chunk = 16 * 1024 * 1024;
    let size = usize::try_from(requested_size)
        .unwrap_or(usize::MAX)
        .min(max_chunk);
    let mut data = Vec::with_capacity(size);
    file.take(size as u64)
        .read_to_end(&mut data)
        .map_err(|e| format!("read '{}': {}", path.display(), e))?;
    Ok(data)
}
