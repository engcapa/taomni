//! Data locations are independent of executable package trust. All callers
//! anchor them below the canonical plugin's `data` subtree.
use std::collections::BTreeSet;
use std::fs::{self, File, Metadata, OpenOptions};
use std::path::{Path, PathBuf};

use taomni_plugin_api::services::SafeRelativePath;
use taomni_profile_locks::PluginSlug;

use super::{ModuleManifest, PluginError};

pub(super) fn validate_manifest(manifest: &ModuleManifest) -> Result<(), PluginError> {
    PluginSlug::parse(manifest.slug.clone()).map_err(|_| invalid("invalid data owner"))?;
    if manifest.data_schema_version == 0 {
        return Err(invalid("dataSchemaVersion must be positive"));
    }
    let prefix = format!("plugins/{}/data", manifest.slug);
    let mut seen = BTreeSet::new();
    for path in &manifest.backup_paths {
        validate_relative(path)?;
        if path != &prefix && !path.starts_with(&format!("{prefix}/")) {
            return Err(invalid("backupPaths must stay below plugins/<slug>/data"));
        }
        if !seen.insert(path.to_lowercase()) {
            return Err(invalid(
                "backupPaths contain duplicate or case-conflicting paths",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_relative(value: &str) -> Result<(), PluginError> {
    SafeRelativePath::parse(value)
        .map_err(|_| invalid("plugin data path must be portable and relative"))?;
    if value.len() > 1024
        || value.split('/').count() > 32
        || value.contains(['<', '>', '"', '|', '?', '*'])
    {
        return Err(invalid("plugin data path exceeds portable path limits"));
    }
    Ok(())
}

/// An opened root is a location, never an authorization to execute code or
/// obtain keys. Missing data is kept missing; discovery does not initialize it.
pub(crate) struct PluginDataRoot {
    pub(crate) data: PathBuf,
}

impl PluginDataRoot {
    pub(crate) fn open(plugins: &Path, slug: &str) -> Result<Self, PluginError> {
        PluginSlug::parse(slug).map_err(|_| invalid("invalid data owner"))?;
        require_directory(plugins)?;
        let plugins = fs::canonicalize(plugins)?;
        let owner = plugins.join(slug);
        for path in [&owner, &owner.join("data")] {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => (),
                Ok(_) => return Err(invalid("plugin data root must be an ordinary directory")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(Self {
            data: owner.join("data"),
        })
    }

    pub(crate) fn resolve_file(&self, relative: &str) -> Result<PathBuf, PluginError> {
        validate_relative(relative)?;
        let mut path = self.data.clone();
        require_directory(&path)?;
        let parts: Vec<_> = relative.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            path.push(part);
            if index + 1 == parts.len() {
                require_file(&fs::symlink_metadata(&path)?)?;
            } else {
                require_directory(&path)?;
            }
        }
        Ok(path)
    }

    pub(crate) fn open_file(&self, relative: &str) -> Result<File, PluginError> {
        let path = self.resolve_file(relative)?;
        open_regular(&path)
    }
}

pub(crate) fn open_regular(path: &Path) -> Result<File, PluginError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    require_file(&file.metadata()?)?;
    Ok(file)
}

pub(crate) fn require_directory(path: &Path) -> Result<(), PluginError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(invalid("plugin data/control directory must not be linked"));
    }
    Ok(())
}

pub(crate) fn require_file(metadata: &Metadata) -> Result<(), PluginError> {
    if !metadata.is_file() || is_link(metadata) {
        return Err(invalid(
            "plugin data must contain only ordinary files/directories",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(invalid("plugin data must not contain hard links"));
        }
    }
    Ok(())
}

pub(crate) fn is_link(metadata: &Metadata) -> bool {
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

pub(crate) fn invalid(message: &str) -> PluginError {
    PluginError::InvalidManifest(message.into())
}
