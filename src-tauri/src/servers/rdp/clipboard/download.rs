use super::files::StagingDir;
use super::files::process_staging_root;
use super::files::staging_base;
use super::limits::FILE_CHUNK_BYTES;
use super::limits::MAX_FILE_ITEMS;
use crate::rdp::session::ensure_private_directory;
use crate::rdp::session::remote_clipboard_safe_path;
use crate::rdp::session::remote_top_level_name;
use crate::rdp::session::write_remote_file_chunk;
use ironrdp::cliprdr::pdu::ClipboardFileAttributes;
use ironrdp::cliprdr::pdu::FileContentsFlags;
use ironrdp::cliprdr::pdu::FileContentsRequest;
use ironrdp::cliprdr::pdu::FileContentsResponse;
use ironrdp::cliprdr::pdu::FileDescriptor;
use std::path::PathBuf;

#[derive(Debug)]
pub(super) struct DownloadEntry {
    pub(super) path: PathBuf,
    pub(super) size: Option<u64>,
    pub(super) is_directory: bool,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Outstanding {
    pub(super) stream_id: u32,
    pub(super) index: usize,
    pub(super) size_request: bool,
}

pub(super) enum Progress {
    Request(FileContentsRequest),
    Done,
}

/// Client → host file transfer with one FileContents request in flight.
pub(super) struct FileDownload {
    pub(super) staging: StagingDir,
    pub(super) entries: Vec<DownloadEntry>,
    pub(super) top_level: Vec<PathBuf>,
    pub(super) data_id: Option<u32>,
    pub(super) quota: u64,
    pub(super) received: u64,
    /// First entry whose data may still be missing.
    pub(super) cursor: usize,
    pub(super) position: u64,
    pub(super) next_stream_id: u32,
    pub(super) outstanding: Option<Outstanding>,
}

impl FileDownload {
    /// Prepare a private staging tree for the client's (already sanitised)
    /// file list. Declared sizes are checked against the quota up front.
    pub(super) fn start(
        files: &[FileDescriptor],
        data_id: Option<u32>,
        quota: u64,
    ) -> Result<Self, String> {
        if files.len() > MAX_FILE_ITEMS {
            return Err(format!("more than {MAX_FILE_ITEMS} file items"));
        }
        ensure_private_directory(&staging_base())?;
        let root = process_staging_root();
        ensure_private_directory(&root)?;
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        ensure_private_directory(&dir)?;
        let staging = StagingDir(dir.clone());

        let mut entries = Vec::with_capacity(files.len());
        let mut top_level = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut declared = 0u64;
        for file in files {
            let wire_name = match &file.relative_path {
                Some(directory) if !directory.is_empty() => format!("{directory}\\{}", file.name),
                _ => file.name.clone(),
            };
            #[cfg(windows)]
            if ironrdp::cliprdr::is_windows_device_name(&file.name) {
                return Err(format!("'{wire_name}' is a reserved device name"));
            }
            let path = remote_clipboard_safe_path(&dir, &wire_name)?;
            if !seen.insert(path.clone()) {
                return Err(format!("duplicate path '{wire_name}'"));
            }
            let is_directory = file
                .attributes
                .is_some_and(|attributes| attributes.contains(ClipboardFileAttributes::DIRECTORY));
            let size = if is_directory {
                Some(0)
            } else {
                file.file_size
            };
            declared = declared.saturating_add(size.unwrap_or(0));
            if declared > quota {
                return Err(format!(
                    "files exceed the {} MiB clipboard limit",
                    quota / (1024 * 1024)
                ));
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create directory '{}': {e}", parent.display()))?;
            }
            if is_directory {
                std::fs::create_dir_all(&path)
                    .map_err(|e| format!("create directory '{}': {e}", path.display()))?;
            } else {
                let mut options = std::fs::OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
                options
                    .open(&path)
                    .map_err(|e| format!("create '{}': {e}", path.display()))?;
            }
            if let Some(name) = remote_top_level_name(&wire_name) {
                let top = dir.join(name);
                if !top_level.contains(&top) {
                    top_level.push(top);
                }
            }
            entries.push(DownloadEntry {
                path,
                size,
                is_directory,
            });
        }
        Ok(Self {
            staging,
            entries,
            top_level,
            data_id,
            quota,
            received: 0,
            cursor: 0,
            position: 0,
            next_stream_id: 1,
            outstanding: None,
        })
    }

    pub(super) fn issue(&mut self, index: usize, size_request: bool) -> Progress {
        let stream_id = self.next_stream_id;
        self.next_stream_id = self.next_stream_id.wrapping_add(1).max(1);
        self.outstanding = Some(Outstanding {
            stream_id,
            index,
            size_request,
        });
        let (flags, position, requested_size) = if size_request {
            (FileContentsFlags::SIZE, 0, 8)
        } else {
            let size = self.entries[index].size.unwrap_or(0);
            let chunk = size
                .saturating_sub(self.position)
                .min(u64::from(FILE_CHUNK_BYTES));
            (FileContentsFlags::RANGE, self.position, chunk as u32)
        };
        Progress::Request(FileContentsRequest {
            stream_id,
            index: index as i32,
            flags,
            position,
            requested_size,
            data_id: self.data_id,
        })
    }

    /// The next request, or `Done` once every file has its declared bytes.
    pub(super) fn next_request(&mut self) -> Progress {
        while let Some(entry) = self.entries.get(self.cursor) {
            match entry.size {
                _ if entry.is_directory => {}
                None => return self.issue(self.cursor, true),
                Some(size) if self.position < size => return self.issue(self.cursor, false),
                Some(_) => {}
            }
            self.cursor += 1;
            self.position = 0;
        }
        Progress::Done
    }

    pub(super) fn accept(
        &mut self,
        response: &FileContentsResponse<'_>,
    ) -> Result<Progress, String> {
        let outstanding = self
            .outstanding
            .take()
            .ok_or("file data arrived without a request")?;
        if response.stream_id() != outstanding.stream_id {
            return Err(format!("unexpected file stream {}", response.stream_id()));
        }
        let entry = &mut self.entries[outstanding.index];
        if response.is_error() {
            return Err(format!(
                "the client could not read '{}'",
                entry.path.display()
            ));
        }
        if outstanding.size_request {
            entry.size = Some(
                response
                    .data_as_size()
                    .map_err(|e| format!("bad file size response: {e}"))?,
            );
            let declared: u64 = self.entries.iter().filter_map(|entry| entry.size).sum();
            if declared > self.quota {
                return Err(format!(
                    "files exceed the {} MiB clipboard limit",
                    self.quota / (1024 * 1024)
                ));
            }
        } else {
            let data = response.data();
            let remaining = entry.size.unwrap_or(0).saturating_sub(self.position);
            if data.is_empty() {
                return Err(format!(
                    "'{}' ended before its declared size",
                    entry.path.display()
                ));
            }
            if data.len() as u64 > remaining || data.len() > FILE_CHUNK_BYTES as usize {
                return Err(format!(
                    "'{}' exceeded its requested range",
                    entry.path.display()
                ));
            }
            self.received = self.received.saturating_add(data.len() as u64);
            if self.received > self.quota {
                return Err("files exceed the clipboard limit".to_string());
            }
            write_remote_file_chunk(&entry.path, self.position, data)?;
            self.position += data.len() as u64;
        }
        Ok(self.next_request())
    }
}
