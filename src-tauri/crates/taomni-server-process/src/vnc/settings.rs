use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub const CONFIG_FILENAME: &str = "config.json";
pub const CONFIG_PATH: &str = "plugins/vnc-server/data/config.json";
const MAX_SETTINGS_BYTES: u64 = 64 * 1024;

/// The module data stores settings and a Vault reference. The core supplies
/// the password to the daemon only for the current start request.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub port: u16,
    pub bind_address: String,
    pub view_only: bool,
    pub shared_desktop: bool,
    pub auto_stop: bool,
    pub auto_stop_seconds: u64,
    pub start_on_launch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_ref: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub credential_migration_required: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 5900,
            bind_address: "0.0.0.0".to_owned(),
            view_only: false,
            shared_desktop: true,
            auto_stop: false,
            auto_stop_seconds: 3600,
            start_on_launch: false,
            password_ref: None,
            credential_migration_required: false,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredSettings {
    pub settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_source: Option<String>,
}

pub struct SettingsFile(PathBuf);

impl SettingsFile {
    pub fn new(profile: &Path) -> Self {
        Self(profile.join(CONFIG_PATH))
    }

    /// A reader opens the atomically replaced file without creating it or
    /// acquiring write ownership. The caller holds a live profile lease.
    pub fn load(&self) -> io::Result<Option<StoredSettings>> {
        let Some(file) = self.open()? else {
            return Ok(None);
        };
        let mut body = Vec::new();
        file.take(MAX_SETTINGS_BYTES + 1).read_to_end(&mut body)?;
        if body.len() as u64 > MAX_SETTINGS_BYTES {
            return Err(invalid_settings());
        }
        serde_json::from_slice(&body)
            .map(Some)
            .map_err(io::Error::other)
    }

    pub fn open(&self) -> io::Result<Option<File>> {
        for directory in self.0.ancestors().skip(1).take(3) {
            match fs::symlink_metadata(directory) {
                Ok(metadata) if metadata.is_dir() && ordinary(&metadata) => {}
                Ok(_) => return Err(invalid_settings()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            }
        }
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
        match options.open(&self.0) {
            Ok(file) => {
                let metadata = file.metadata()?;
                if !metadata.is_file() || !ordinary(&metadata) {
                    return Err(invalid_settings());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.nlink() != 1 {
                        return Err(invalid_settings());
                    }
                }
                Ok(Some(file))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Callers must hold the module writer lease. Receipt and settings share
    /// one atomic file so interrupted migrations can recover their identity.
    pub fn save(&self, record: &StoredSettings) -> io::Result<()> {
        let directories: Vec<_> = self.0.ancestors().skip(1).take(3).collect();
        for directory in directories.iter().rev() {
            match fs::create_dir(directory) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            let metadata = fs::symlink_metadata(directory)?;
            if !metadata.is_dir() || !ordinary(&metadata) {
                return Err(invalid_settings());
            }
        }
        self.open()?;
        let contents = serde_json::to_vec(record).map_err(io::Error::other)?;
        if contents.len() as u64 > MAX_SETTINGS_BYTES {
            return Err(invalid_settings());
        }
        let parent = directories[0];
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&contents)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&self.0).map_err(|error| error.error)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    }
}

fn ordinary(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 == 0
    }
    #[cfg(not(windows))]
    !metadata.file_type().is_symlink()
}

fn invalid_settings() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid VNC Server settings file",
    )
}
