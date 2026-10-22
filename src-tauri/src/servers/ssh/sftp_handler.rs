use super::sftp_attributes::apply_file_attributes;
use super::sftp_attributes::apply_file_attributes_on_file;
use super::sftp_paths::canonical_client_path;
use super::sftp_paths::confine_path;
use crate::servers::engine::LogEmitter;
use russh_sftp::protocol::File;
use russh_sftp::protocol::FileAttributes;
use russh_sftp::protocol::Handle as SftpHandle;
use russh_sftp::protocol::Name;
use russh_sftp::protocol::Status;
use russh_sftp::protocol::StatusCode;
use russh_sftp::protocol::Version;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/* ------------------------------- SFTP -------------------------------- */

/// In-process SFTP handler rooted at `root`. Paths from the client are treated
/// as absolute within the export and are confined to `root` (no escaping via
/// `..` or absolute paths).
pub(super) struct SftpHandler {
    pub(super) root: Arc<PathBuf>,
    pub(super) log: LogEmitter,
    pub(super) version: Option<u32>,
    /// Open file handles keyed by an opaque handle string we hand to the client.
    pub(super) files: HashMap<String, Arc<Mutex<std::fs::File>>>,
    /// Open dir handles -> already-listed flag and the resolved path.
    pub(super) dirs: HashMap<String, DirState>,
    pub(super) next_handle: u64,
}

pub(super) struct DirState {
    pub(super) path: PathBuf,
    pub(super) sent: bool,
}

impl SftpHandler {
    pub(super) fn new(root: Arc<PathBuf>, log: LogEmitter) -> Self {
        Self {
            root,
            log,
            version: None,
            files: HashMap::new(),
            dirs: HashMap::new(),
            next_handle: 0,
        }
    }

    pub(super) fn alloc_handle(&mut self, prefix: &str) -> String {
        let h = format!("{}-{}", prefix, self.next_handle);
        self.next_handle += 1;
        h
    }

    /// Map a client-supplied path (treated as absolute under the export root)
    /// onto a real filesystem path, refusing anything that escapes the root.
    pub(super) fn resolve(&self, requested: &str) -> Result<PathBuf, StatusCode> {
        confine_path(&self.root, requested)
    }
}

pub(super) fn io_to_status(e: &std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

pub(super) fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

impl russh_sftp::server::Handler for SftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        if self.version.is_some() {
            return Err(StatusCode::ConnectionLost);
        }
        self.version = Some(version);
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        // Resolve to a canonical client-visible absolute path (rooted at "/").
        let resolved = self.resolve(&path)?;
        let display = canonical_client_path(&self.root, &resolved);
        Ok(Name {
            id,
            files: vec![File::dummy(display)],
        })
    }

    async fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::metadata(&p).map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn lstat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::symlink_metadata(&p).map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn fstat(
        &mut self,
        id: u32,
        handle: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let guard = file.lock().await;
        let meta = guard.metadata().map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<SftpHandle, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::metadata(&p).map_err(|e| io_to_status(&e))?;
        if !meta.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        let handle = self.alloc_handle("dir");
        self.dirs.insert(
            handle.clone(),
            DirState {
                path: p,
                sent: false,
            },
        );
        Ok(SftpHandle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let state = self.dirs.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if state.sent {
            return Err(StatusCode::Eof);
        }
        let mut files = Vec::new();
        let entries = std::fs::read_dir(&state.path).map_err(|e| io_to_status(&e))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let attrs = match entry.metadata() {
                Ok(m) => FileAttributes::from(&m),
                Err(_) => FileAttributes::default(),
            };
            files.push(File::new(name, attrs));
        }
        state.sent = true;
        Ok(Name { id, files })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: russh_sftp::protocol::OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<SftpHandle, Self::Error> {
        let p = self.resolve(&filename)?;
        let opts: std::fs::OpenOptions = pflags.into();
        let file = opts.open(&p).map_err(|e| io_to_status(&e))?;
        let handle = self.alloc_handle("file");
        self.files
            .insert(handle.clone(), Arc::new(Mutex::new(file)));
        Ok(SftpHandle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        use std::io::{Read, Seek, SeekFrom};
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let mut guard = file.lock().await;
        guard
            .seek(SeekFrom::Start(offset))
            .map_err(|e| io_to_status(&e))?;
        let mut buf = vec![0u8; len as usize];
        let n = guard.read(&mut buf).map_err(|e| io_to_status(&e))?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(russh_sftp::protocol::Data { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        use std::io::{Seek, SeekFrom, Write};
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let mut guard = file.lock().await;
        guard
            .seek(SeekFrom::Start(offset))
            .map_err(|e| io_to_status(&e))?;
        guard.write_all(&data).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.files.remove(&handle);
        self.dirs.remove(&handle);
        Ok(ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let p = self.resolve(&filename)?;
        std::fs::remove_file(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let p = self.resolve(&path)?;
        std::fs::create_dir(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let p = self.resolve(&path)?;
        std::fs::remove_dir(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let from = self.resolve(&oldpath)?;
        let to = self.resolve(&newpath)?;
        std::fs::rename(&from, &to).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let p = self.resolve(&path)?;
        apply_file_attributes(&p, &attrs).map_err(|e| {
            self.log.line(format!("setstat {}: {}", p.display(), e));
            StatusCode::Failure
        })?;
        Ok(ok_status(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        handle: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let guard = file.lock().await;
        // Prefer path via file metadata only — re-open by path isn't available.
        // Apply times via the File handle where the platform allows.
        apply_file_attributes_on_file(&guard, &attrs).map_err(|e| {
            self.log.line(format!("fsetstat: {}", e));
            StatusCode::Failure
        })?;
        Ok(ok_status(id))
    }

    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let p = self.resolve(&path)?;
        let target = std::fs::read_link(&p).map_err(|e| io_to_status(&e))?;
        let display = target.to_string_lossy().replace('\\', "/");
        Ok(Name {
            id,
            files: vec![File::dummy(display)],
        })
    }

    async fn symlink(
        &mut self,
        id: u32,
        linkpath: String,
        targetpath: String,
    ) -> Result<Status, Self::Error> {
        let link = self.resolve(&linkpath)?;
        // Target may be relative to the link location as seen by the client; store
        // the client-supplied string as the symlink body when it is not absolute
        // under our export. For absolute client paths, resolve under root.
        let target = if targetpath.starts_with('/') {
            self.resolve(&targetpath)?
        } else {
            PathBuf::from(&targetpath)
        };
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).map_err(|e| io_to_status(&e))?;
        }
        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(&target, &link).map_err(|e| io_to_status(&e))?;
            } else {
                std::os::windows::fs::symlink_file(&target, &link).map_err(|e| io_to_status(&e))?;
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (link, target);
            return Err(StatusCode::OpUnsupported);
        }
        Ok(ok_status(id))
    }
}
