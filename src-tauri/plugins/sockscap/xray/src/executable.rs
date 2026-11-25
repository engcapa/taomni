use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

pub(super) enum XrayExecutable {
    Fixture(Option<PathBuf>),
    Packaged(PathBuf),
}

impl XrayExecutable {
    pub fn prepare(&self, work_dir: &Path) -> Result<PathBuf, String> {
        match self {
            Self::Fixture(exe) => exe.clone().ok_or_else(|| {
                "xray-core binary not found (run scripts/fetch-xray.ps1)".to_owned()
            }),
            Self::Packaged(source) => {
                // Open the resource on each spawn, including a health restart.
                // Only the verified bytes in the private staging folder are executed.
                let pin: serde_json::Value =
                    serde_json::from_str(include_str!("../../resources/xray/release.json"))
                        .map_err(|e| e.to_string())?;
                let platform = format!(
                    "{}-{}",
                    if cfg!(target_os = "macos") {
                        "darwin"
                    } else {
                        std::env::consts::OS
                    },
                    std::env::consts::ARCH
                );
                let expected = pin["platforms"][&platform]["binarySha256"]
                    .as_str()
                    .ok_or_else(|| format!("Xray is unavailable on {platform}"))?;
                for path in [
                    source.as_path(),
                    source.parent().ok_or("Missing Xray directory")?,
                ] {
                    if fs::symlink_metadata(path)
                        .map_err(|e| format!("Read signed SocksCap Xray resource: {e}"))?
                        .is_symlink()
                    {
                        return Err(
                            "Signed SocksCap Xray resource must not be a symbolic link".into()
                        );
                    }
                }
                let mut bytes = Vec::new();
                File::open(source)
                    .map_err(|e| format!("Open signed SocksCap Xray resource: {e}"))?
                    .take(64 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| format!("Read signed SocksCap Xray resource: {e}"))?;
                if bytes.len() > 64 * 1024 * 1024 || hex::encode(Sha256::digest(&bytes)) != expected
                {
                    return Err("Xray bytes differ from the signed SocksCap release".into());
                }
                let destination = work_dir.join(taomni_sockscap_api::XRAY_FILE);
                if fs::symlink_metadata(work_dir)
                    .map_err(|e| e.to_string())?
                    .is_symlink()
                {
                    return Err(
                        "The SocksCap Xray work directory must not be a symbolic link".into(),
                    );
                }
                if fs::symlink_metadata(&destination).is_ok_and(|metadata| {
                    metadata.is_file() && metadata.len() == bytes.len() as u64
                }) && fs::read(&destination).is_ok_and(|saved| saved == bytes)
                {
                    return Ok(destination);
                }
                let mut staged = tempfile::NamedTempFile::new_in(work_dir)
                    .map_err(|e| format!("Create private Xray executable file: {e}"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    staged
                        .as_file()
                        .set_permissions(fs::Permissions::from_mode(0o700))
                        .map_err(|e| format!("Set Xray executable permissions: {e}"))?;
                }
                staged
                    .write_all(&bytes)
                    .map_err(|e| format!("Stage signed SocksCap Xray executable: {e}"))?;
                staged
                    .persist(&destination)
                    .map_err(|e| format!("Publish signed SocksCap Xray executable: {e}"))?;
                Ok(destination)
            }
        }
    }
}
