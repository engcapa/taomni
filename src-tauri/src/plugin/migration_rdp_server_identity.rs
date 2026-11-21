//! Preserve a previously trusted RDP server identity on first module install.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};

use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};
use taomni_server_process::rdp;

use super::{ModuleManifest, migration::paths};

const IDENTITY_FILES: [&str; 2] = ["cert.pem", "key.pem"];
const MAX_PEM_SIZE: u64 = 64 * 1024;

pub(super) fn prepare(plugins: &Path, manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != rdp::SLUG || !manifest.commands.contains(rdp::START) {
        return Ok(());
    }
    let profile = ProfileRoot::prepare(
        plugins
            .parent()
            .ok_or("RDP Server profile root unavailable")?,
    )
    .map_err(|error| error.to_string())?;
    let slug = PluginSlug::parse(rdp::SLUG).map_err(|error| error.to_string())?;
    let _lease =
        PluginDataLease::try_acquire(&profile, &slug).map_err(|error| error.to_string())?;
    let module = profile.path().join("plugins").join(rdp::SLUG);
    import_identity(&profile.path().join(rdp::SLUG), &module)
}

fn import_identity(legacy: &Path, module: &Path) -> Result<(), String> {
    if !legacy.try_exists().map_err(|error| error.to_string())? {
        return Ok(());
    }
    paths::directory(legacy)?;
    paths::directory(module)?;
    let destination = module.join("data");
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            paths::directory(&destination)?;
            let certificate = paths::file_exists(&destination.join(IDENTITY_FILES[0]))?;
            let key = paths::file_exists(&destination.join(IDENTITY_FILES[1]))?;
            if certificate && key {
                return Ok(());
            }
            if certificate || key {
                return Err("RDP Server module TLS identity has only one file".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let certificate = paths::file_exists(&legacy.join(IDENTITY_FILES[0]))?;
    let key = paths::file_exists(&legacy.join(IDENTITY_FILES[1]))?;
    if !certificate && !key {
        return Ok(());
    }
    if certificate != key {
        return Err("Previous RDP Server TLS identity has only one file".into());
    }
    let stage = tempfile::Builder::new()
        .prefix(".identity-")
        .tempdir_in(module)
        .map_err(|error| error.to_string())?;
    for name in IDENTITY_FILES {
        let mut data = zeroize::Zeroizing::new(Vec::new());
        paths::open_file(&legacy.join(name))?
            .take(MAX_PEM_SIZE + 1)
            .read_to_end(&mut data)
            .map_err(|error| error.to_string())?;
        if data.is_empty() || data.len() as u64 > MAX_PEM_SIZE {
            return Err("Invalid previous RDP Server TLS identity size".into());
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(stage.path().join(name))
            .map_err(|error| error.to_string())?;
        file.write_all(&data).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    paths::sync_directory(stage.path())?;
    match fs::remove_dir(&destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    fs::rename(stage.path(), &destination).map_err(|error| error.to_string())?;
    paths::sync_directory(module)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_both_files_and_keeps_the_original_after_retry() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("old");
        let module = root.path().join("module");
        fs::create_dir(&legacy).unwrap();
        fs::create_dir(&module).unwrap();
        fs::write(legacy.join("cert.pem"), b"old cert").unwrap();
        assert!(import_identity(&legacy, &module).is_err());
        assert!(!module.join("data").exists());
        fs::write(legacy.join("key.pem"), b"old key").unwrap();
        import_identity(&legacy, &module).unwrap();
        assert_eq!(fs::read(module.join("data/cert.pem")).unwrap(), b"old cert");
        assert_eq!(fs::read(module.join("data/key.pem")).unwrap(), b"old key");
        assert_eq!(fs::read(legacy.join("key.pem")).unwrap(), b"old key");
        fs::write(legacy.join("cert.pem"), b"changed old cert").unwrap();
        import_identity(&legacy, &module).unwrap();
        assert_eq!(fs::read(module.join("data/cert.pem")).unwrap(), b"old cert");
    }
}
