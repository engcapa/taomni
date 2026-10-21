use super::staging::clipboard_process_staging_root;
use super::staging::ensure_private_directory;
use crate::rdp::session::MAX_CLIPBOARD_FILE_BYTES;
use crate::rdp::session::MAX_CLIPBOARD_FILE_ITEMS;
use crate::rdp::session::MAX_CLIPBOARD_TOTAL_BYTES;
use crate::rdp::session::REMOTE_FILE_CHUNK_SIZE;
use crate::rdp::session::RemoteClipboardFile;
use crate::rdp::session::RemoteFileStream;
use crate::rdp::session::RemoteFileTransfer;
use crate::rdp::session::StagingDirectory;
use crate::rdp::session::display;
use ironrdp::cliprdr::pdu::ClipboardFileAttributes;
use ironrdp::cliprdr::pdu::FileContentsFlags;
use ironrdp::cliprdr::pdu::FileContentsRequest;
use ironrdp::cliprdr::pdu::PackedFileList;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::fs::OpenOptions;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

pub(in crate::rdp::session) fn build_remote_file_transfer(
    list: PackedFileList,
) -> Result<(RemoteFileTransfer, Vec<FileContentsRequest>), String> {
    if list.files.len() > MAX_CLIPBOARD_FILE_ITEMS {
        return Err(format!(
            "remote file clipboard contains more than {} items",
            MAX_CLIPBOARD_FILE_ITEMS
        ));
    }
    let process_root = clipboard_process_staging_root();
    ensure_private_directory(&process_root)?;
    let staging_dir = process_root.join(uuid::Uuid::new_v4().to_string());
    ensure_private_directory(&staging_dir)?;
    let staging = StagingDirectory(staging_dir.clone());

    let mut files = Vec::with_capacity(list.files.len());
    let mut top_level_names = HashSet::new();
    let mut top_level_paths = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut total_bytes = 0u64;
    for file in list.files {
        let is_directory = file
            .attributes
            .unwrap_or_else(ClipboardFileAttributes::empty)
            .contains(ClipboardFileAttributes::DIRECTORY);
        let path = remote_clipboard_safe_path(&staging_dir, &file.name)?;
        if !seen_paths.insert(path.clone()) {
            return Err(format!(
                "remote file clipboard contains duplicate path '{}'",
                file.name
            ));
        }
        let file_size = file.file_size.unwrap_or_default();
        if !is_directory && file_size > MAX_CLIPBOARD_FILE_BYTES {
            return Err(format!(
                "remote clipboard file '{}' exceeds the {} MiB per-file quota",
                file.name,
                MAX_CLIPBOARD_FILE_BYTES / (1024 * 1024)
            ));
        }
        total_bytes = total_bytes.saturating_add(file_size);
        if total_bytes > MAX_CLIPBOARD_TOTAL_BYTES {
            return Err(format!(
                "remote file clipboard exceeds the {} MiB total quota",
                MAX_CLIPBOARD_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create directory '{}': {}", parent.display(), e))?;
        }
        if is_directory {
            fs::create_dir_all(&path)
                .map_err(|e| format!("create directory '{}': {}", path.display(), e))?;
        } else {
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            options
                .open(&path)
                .map_err(|e| format!("create '{}': {}", path.display(), e))?;
        }

        if let Some(name) = remote_top_level_name(&file.name) {
            if top_level_names.insert(name.clone()) {
                top_level_paths.push(staging_dir.join(name));
            }
        }

        files.push(RemoteClipboardFile {
            path,
            size: file_size,
            is_directory,
        });
    }

    let mut transfer = RemoteFileTransfer {
        staging,
        files,
        top_level_paths,
        streams: HashMap::new(),
        next_stream_id: 1,
        received_bytes: 0,
    };
    let mut requests = Vec::new();
    for index in 0..transfer.files.len() {
        let file = &transfer.files[index];
        if !file.is_directory && file.size > 0 {
            requests.push(next_remote_file_request(&mut transfer, index, 0));
        }
    }

    Ok((transfer, requests))
}

pub(in crate::rdp::session) fn next_remote_file_request(
    transfer: &mut RemoteFileTransfer,
    index: usize,
    position: u64,
) -> FileContentsRequest {
    let file = &transfer.files[index];
    let remaining = file.size.saturating_sub(position);
    let requested_size = remaining.min(u64::from(REMOTE_FILE_CHUNK_SIZE)) as u32;
    let stream_id = transfer.next_stream_id;
    transfer.next_stream_id = transfer.next_stream_id.wrapping_add(1).max(1);
    transfer
        .streams
        .insert(stream_id, RemoteFileStream { index, position });
    FileContentsRequest {
        stream_id,
        index: index as i32,
        flags: FileContentsFlags::RANGE,
        position,
        requested_size,
        data_id: None,
    }
}

pub(crate) fn remote_clipboard_safe_path(
    root: &Path,
    remote_name: &str,
) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    let mut saw_part = false;
    for part in remote_name.split(['\\', '/']) {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(format!("remote clipboard path '{}' is unsafe", remote_name));
        }
        saw_part = true;
        path.push(part);
    }
    if !saw_part {
        return Err("remote clipboard file has an empty name".to_string());
    }
    Ok(path)
}

pub(crate) fn remote_top_level_name(remote_name: &str) -> Option<PathBuf> {
    remote_name
        .split(['\\', '/'])
        .find(|part| !part.trim().is_empty() && *part != "." && *part != "..")
        .map(PathBuf::from)
}

pub(crate) fn write_remote_file_chunk(
    path: &Path,
    position: u64,
    data: &[u8],
) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|e| format!("open '{}': {}", path.display(), e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| format!("seek '{}': {}", path.display(), e))?;
    file.write_all(data)
        .map_err(|e| format!("write '{}': {}", path.display(), e))
}
