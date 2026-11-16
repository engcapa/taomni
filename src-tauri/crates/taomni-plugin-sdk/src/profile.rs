//! The actual host owns its leases through the last business worker's lifetime.
use serde::Deserialize;
use std::{
    fs,
    io::{self, Read},
    path::Path,
};
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{HOST_PROFILE_ENV, HostProfileContext, ProfileGeneration},
};
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot, ProfileUseLease};

#[derive(Debug)]
pub struct HostStorage {
    root: ProfileRoot,
    context: HostProfileContext,
    // Release the writer before the shared profile lease.
    _data: PluginDataLease,
    _profile: ProfileUseLease,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvironmentProfile {
    root: std::path::PathBuf,
    context: HostProfileContext,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationRecord {
    format_version: u16,
    generation: ProfileGeneration,
}

impl HostStorage {
    pub fn acquire(root: &Path, context: HostProfileContext, plugin_id: &str) -> io::Result<Self> {
        let owner = PluginSlug::parse(context.owner.clone()).map_err(io::Error::other)?;
        if plugin_id.strip_prefix("taomni-plugin-") != Some(owner.as_str())
            || !root.is_absolute()
            || fs::canonicalize(root)? != root
        {
            return Err(invalid_profile());
        }
        let root = ProfileRoot::prepare(root).map_err(io::Error::other)?;
        let profile = ProfileUseLease::try_acquire(&root).map_err(io::Error::other)?;
        let data = PluginDataLease::try_acquire(&root, &owner).map_err(io::Error::other)?;
        // Read only coordination metadata, never a core DB. No restore can
        // change this generation while this host owns its shared lease.
        let state = read_generation(root.path())?;
        if state.format_version != 1 || state.generation != context.generation {
            return Err(invalid_profile());
        }
        Ok(Self {
            root,
            context,
            _data: data,
            _profile: profile,
        })
    }

    pub fn from_environment(plugin_id: &str) -> io::Result<Option<Self>> {
        let Some(value) = std::env::var_os(HOST_PROFILE_ENV) else {
            return Ok(None);
        };
        let environment: EnvironmentProfile =
            serde_json::from_str(value.to_str().ok_or_else(invalid_profile)?)
                .map_err(|_| invalid_profile())?;
        Self::acquire(&environment.root, environment.context, plugin_id).map(Some)
    }

    pub fn root(&self) -> &ProfileRoot {
        &self.root
    }
    pub fn context(&self) -> &HostProfileContext {
        &self.context
    }
}

/// An incoming request cannot create ownership or choose a profile. Legacy
/// stream fixtures keep an absent profile; production requires an exact ack.
pub fn confirm_profile_handshake(
    storage: Option<&HostStorage>,
    requested: Option<&HostProfileContext>,
) -> Result<Option<HostProfileContext>, RpcError> {
    match (storage, requested) {
        (None, None) => Ok(None),
        (Some(storage), Some(requested)) if storage.context() == requested => {
            Ok(Some(requested.clone()))
        }
        _ => Err(RpcError::from_code(ErrorCode::InvalidState)),
    }
}

fn read_generation(root: &Path) -> io::Result<GenerationRecord> {
    let path = root.join(".profile-state.json");
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
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(invalid_profile());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid_profile());
        }
    }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(invalid_profile());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid_profile())
}

fn invalid_profile() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid plugin profile ownership",
    )
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;
