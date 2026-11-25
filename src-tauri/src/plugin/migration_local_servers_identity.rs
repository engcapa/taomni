//! Retain the old SSH host key when Local servers moves into a signed host.

use std::{
    io::{Read, Write},
    path::Path,
};

use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};
use taomni_server_process::local;

use super::{ModuleManifest, migration::paths};

pub(super) fn prepare(plugins: &Path, manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != local::SLUG || !manifest.commands.contains(local::START) {
        return Ok(());
    }
    let profile = ProfileRoot::prepare(plugins.parent().ok_or("Local servers profile is missing")?)
        .map_err(|error| error.to_string())?;
    let slug = PluginSlug::parse(local::SLUG).map_err(|error| error.to_string())?;
    let _writer =
        PluginDataLease::try_acquire(&profile, &slug).map_err(|error| error.to_string())?;
    import(profile.path())
}

fn import(profile: &Path) -> Result<(), String> {
    let legacy = profile.join("ssh-server");
    if !legacy.try_exists().map_err(|error| error.to_string())? {
        return Ok(());
    }
    paths::directory(&legacy)?;
    let source = legacy.join(local::HOST_KEY);
    let identity = local::SshIdentity::new(profile);
    if !paths::file_exists(&source)?
        || identity
            .open()
            .map_err(|error| error.to_string())?
            .is_some()
    {
        return Ok(());
    }
    let mut key = zeroize::Zeroizing::new(Vec::new());
    const MAX_KEY: u64 = 64 * 1024;
    paths::open_file(&source)?
        .take(MAX_KEY + 1)
        .read_to_end(&mut key)
        .map_err(|error| error.to_string())?;
    if key.is_empty() || key.len() as u64 > MAX_KEY {
        return Err("Invalid previous SSH host key size".into());
    }
    let directory = identity.directory().map_err(|error| error.to_string())?;
    let mut staged =
        tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    staged.write_all(&key).map_err(|error| error.to_string())?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    staged
        .persist_noclobber(directory.join(local::HOST_KEY))
        .map_err(|error| error.to_string())?;
    paths::sync_directory(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn retries_preserve_the_original_and_active_host_keys() {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path();
        import(root).unwrap();
        let legacy = root.join("ssh-server");
        fs::create_dir(&legacy).unwrap();
        let source = legacy.join(local::HOST_KEY);
        fs::write(&source, b"previous host key").unwrap();
        import(root).unwrap();
        let active = root.join(local::HOST_KEY_PATH);
        assert_eq!(fs::read(&active).unwrap(), b"previous host key");
        fs::write(&active, b"current host key").unwrap();
        import(root).unwrap();
        assert_eq!(fs::read(source).unwrap(), b"previous host key");
        assert_eq!(fs::read(active).unwrap(), b"current host key");
    }
}
