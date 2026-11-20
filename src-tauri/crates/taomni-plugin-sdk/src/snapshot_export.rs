//! The authenticated grant controls every output; providers never choose roots.
use crate::Operation;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{SafeRelativePath, Sha256Digest, SnapshotDestinationGrant, SnapshotFile},
};
use taomni_sqlite_snapshot::{SnapshotControl, SnapshotObserver};

pub struct SnapshotExport {
    root: PathBuf,
    allowed: BTreeSet<String>,
    opaque: BTreeSet<String>,
    completed: BTreeMap<String, SnapshotFile>,
    operation: Arc<Operation>,
}

pub(crate) fn invalid() -> RpcError {
    RpcError::from_code(ErrorCode::InvalidParams)
}

pub(crate) fn io_error(_: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "PLUGIN_SNAPSHOT_FAILED")
}

impl SnapshotExport {
    pub fn allowed_paths(&self) -> impl Iterator<Item = &str> {
        self.allowed.iter().map(String::as_str)
    }

    pub fn is_opaque_file(&self, relative: &str) -> bool {
        self.opaque.contains(relative)
    }

    pub(crate) fn validate(
        grant: &SnapshotDestinationGrant,
        profile: &Path,
    ) -> Result<(), RpcError> {
        let path = &grant.absolute_job_root;
        if !path.is_absolute()
            || fs::canonicalize(path).map_err(io_error)? != *path
            || path == profile
            || path.starts_with(profile.join("plugins"))
            || grant.allowed_files.len() > 16_384
            || serde_json::to_vec(grant).map_err(|_| invalid())?.len() > 1024 * 1024
        {
            return Err(invalid());
        }
        directory(path)?;
        if fs::read_dir(path).map_err(io_error)?.next().is_some() {
            return Err(invalid());
        }
        let allowed: BTreeSet<_> = grant
            .allowed_files
            .iter()
            .map(SafeRelativePath::as_str)
            .collect();
        let opaque: BTreeSet<_> = grant
            .opaque_files
            .iter()
            .map(SafeRelativePath::as_str)
            .collect();
        if opaque.len() != grant.opaque_files.len() || !opaque.is_subset(&allowed) {
            return Err(invalid());
        }
        let mut paths = BTreeSet::new();
        let mut prefixes = BTreeMap::new();
        for relative in &grant.allowed_files {
            let value = relative.as_str();
            if value.len() > 1024
                || value.split('/').count() > 32
                || value.contains(['<', '>', '"', '|', '?', '*'])
                || !paths.insert(value.to_lowercase())
            {
                return Err(invalid());
            }
            let mut prefix = String::new();
            for part in value.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                if prefixes
                    .insert(prefix.to_lowercase(), prefix.clone())
                    .is_some_and(|old| old != prefix)
                {
                    return Err(invalid());
                }
            }
        }
        for path in &paths {
            let mut parent = path.as_str();
            while let Some((next, _)) = parent.rsplit_once('/') {
                if paths.contains(next) {
                    return Err(invalid());
                }
                parent = next;
            }
        }
        Ok(())
    }

    pub(crate) fn new(grant: &SnapshotDestinationGrant, operation: Arc<Operation>) -> Self {
        Self {
            root: grant.absolute_job_root.clone(),
            allowed: grant
                .allowed_files
                .iter()
                .map(|path| path.as_str().into())
                .collect(),
            opaque: grant
                .opaque_files
                .iter()
                .map(|path| path.as_str().into())
                .collect(),
            completed: BTreeMap::new(),
            operation,
        }
    }

    /// The provider supplies its authoritative open connection. Never reopen a
    /// running store by filename or fall back to copying its database file.
    pub fn sqlite(
        &mut self,
        relative: &str,
        connection: &rusqlite::Connection,
    ) -> Result<(), RpcError> {
        if self.is_opaque_file(relative) {
            return Err(invalid());
        }
        let target = self.target(relative)?;
        let control = SnapshotControl::new(
            self.operation.deadline(),
            Arc::new(Cancellation(self.operation.clone())),
        );
        taomni_sqlite_snapshot::snapshot_connection(
            connection,
            &target,
            &Default::default(),
            &control,
        )
        .map_err(|error| {
            self.operation
                .check_current()
                .err()
                .unwrap_or_else(|| io_error(error))
        })?;
        self.finish(relative, &target)
    }

    pub fn file(&mut self, relative: &str, mut source: File) -> Result<(), RpcError> {
        regular(&source.metadata().map_err(io_error)?)?;
        source.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let mut header = Vec::with_capacity(16);
        (&mut source)
            .take(16)
            .read_to_end(&mut header)
            .map_err(io_error)?;
        if header == b"SQLite format 3\0" && !self.is_opaque_file(relative) {
            return Err(RpcError::new(
                ErrorCode::InvalidState,
                "PLUGIN_SQLITE_SNAPSHOT_REQUIRED",
            ));
        }
        source.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let target = self.target(relative)?;
        let mut partial = tempfile::NamedTempFile::new_in(target.parent().ok_or_else(invalid)?)
            .map_err(io_error)?;
        let mut bytes = [0; 65_536];
        loop {
            self.operation.check_current()?;
            let count = source.read(&mut bytes).map_err(io_error)?;
            if count == 0 {
                break;
            }
            partial.write_all(&bytes[..count]).map_err(io_error)?;
        }
        partial.as_file().sync_all().map_err(io_error)?;
        self.operation.check_current()?;
        partial.persist_noclobber(&target).map_err(io_error)?;
        self.finish(relative, &target)
    }

    pub(crate) fn complete(self) -> Result<Vec<SnapshotFile>, RpcError> {
        self.operation.check_current()?;
        if self.allowed != self.completed.keys().cloned().collect() {
            return Err(RpcError::new(
                ErrorCode::InvalidState,
                "PLUGIN_SNAPSHOT_INCOMPLETE",
            ));
        }
        Ok(self.completed.into_values().collect())
    }

    fn target(&self, relative: &str) -> Result<PathBuf, RpcError> {
        self.operation.check_current()?;
        SafeRelativePath::parse(relative).map_err(|_| invalid())?;
        if !self.allowed.contains(relative) || self.completed.contains_key(relative) {
            return Err(invalid());
        }
        directory(&self.root)?;
        let mut path = self.root.clone();
        let parts: Vec<_> = relative.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            path.push(part);
            match fs::create_dir(&path) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(io_error(error)),
            }
            directory(&path)?;
        }
        path.push(parts.last().ok_or_else(invalid)?);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
            _ => Err(invalid()),
        }
    }

    fn finish(&mut self, relative: &str, path: &Path) -> Result<(), RpcError> {
        let mut file = open_regular(path)?;
        let mut digest = Sha256::new();
        let mut size = 0;
        let mut bytes = [0; 65_536];
        loop {
            self.operation.check_current()?;
            let count = file.read(&mut bytes).map_err(io_error)?;
            if count == 0 {
                break;
            }
            digest.update(&bytes[..count]);
            size += count as u64;
        }
        self.completed.insert(
            relative.into(),
            SnapshotFile {
                relative_path: SafeRelativePath::parse(relative).map_err(|_| invalid())?,
                size_bytes: size,
                sha256: Sha256Digest::parse(format!("{:x}", digest.finalize()))
                    .map_err(|_| invalid())?,
            },
        );
        Ok(())
    }
}

struct Cancellation(Arc<Operation>);
impl SnapshotObserver for Cancellation {
    fn is_cancelled(&self) -> bool {
        self.0.check_current().is_err()
    }
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn regular(metadata: &fs::Metadata) -> Result<(), RpcError> {
    if !metadata.is_file() || linked(metadata) {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(crate) fn directory(path: &Path) -> Result<(), RpcError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir() || linked(&metadata) {
        return Err(invalid());
    }
    Ok(())
}

fn open_regular(path: &Path) -> Result<File, RpcError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).map_err(io_error)?;
    regular(&file.metadata().map_err(io_error)?)?;
    Ok(file)
}
