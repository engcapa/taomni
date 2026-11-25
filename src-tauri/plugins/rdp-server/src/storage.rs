use std::{
    fs::{self, File, Metadata, OpenOptions},
    io,
    path::{Path, PathBuf},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{Operation, SnapshotExport, SnapshotProvider};
use taomni_server_process::{ServerConfig, rdp};

pub(super) struct Identity(PathBuf);

impl Identity {
    pub(super) fn new(profile: &Path) -> Self {
        Self(profile.to_owned())
    }

    pub(super) fn directory(&self, create: bool) -> io::Result<Option<PathBuf>> {
        let mut directory = self.0.clone();
        for segment in ["plugins", "rdp-server", "data"] {
            directory.push(segment);
            if create {
                match fs::create_dir(&directory) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
            }
            match fs::symlink_metadata(&directory) {
                Ok(metadata) if metadata.is_dir() && !linked(&metadata) => {}
                Ok(_) => return Err(invalid()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            }
        }
        Ok(Some(directory))
    }

    pub(super) fn prepare(&self) -> io::Result<PathBuf> {
        let directory = self.directory(true)?.ok_or_else(invalid)?;
        open_identity(&directory.join("cert.pem"))?;
        open_identity(&directory.join("key.pem"))?;
        Ok(directory)
    }

    pub(super) fn save_settings(
        &self,
        settings: ServerConfig,
        operation: &Operation,
    ) -> Result<(), RpcError> {
        let file = rdp::SettingsFile::new(&self.0);
        let legacy_source = file
            .load()
            .map_err(error)?
            .and_then(|record| record.legacy_source);
        operation.check_current()?;
        file.save(&rdp::StoredSettings {
            settings,
            legacy_source,
        })
        .map_err(error)
    }
}

impl SnapshotProvider for Identity {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()
    }

    fn export(&self, export: &mut SnapshotExport, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()?;
        if let Some(file) = rdp::SettingsFile::new(&self.0).open().map_err(error)? {
            export.file(rdp::CONFIG_FILENAME, file)?;
        }
        if let Some(directory) = self.directory(false).map_err(error)? {
            let cert = open_identity(&directory.join("cert.pem")).map_err(error)?;
            let key = open_identity(&directory.join("key.pem")).map_err(error)?;
            match (cert, key) {
                (Some(cert), Some(key)) => {
                    export.file("cert.pem", cert)?;
                    export.file("key.pem", key)?;
                }
                (None, None) => {}
                _ => return Err(error(invalid())),
            }
        }
        Ok(())
    }

    fn resume(&self) {}
}

fn open_identity(path: &Path) -> io::Result<Option<File>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || linked(&metadata) {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(invalid());
        }
    }
    Ok(Some(file))
}

fn linked(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid RDP Server TLS identity files",
    )
}

pub(super) fn error(error: io::Error) -> RpcError {
    RpcError::new(
        ErrorCode::InternalError,
        format!("RDP Server storage: {error}"),
    )
}
