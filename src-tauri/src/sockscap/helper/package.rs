//! Prepare the auxiliary Windows capture process from the verified module.

use std::{
    cmp::Ordering,
    fs::{self, File},
    io::{self, Read, Write},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

use taomni_sockscap_api::{RUNTIME_INFO, RuntimeInfo, SLUG};
use tauri::AppHandle;
use winapi::um::{winbase::FILE_FLAG_OPEN_REPARSE_POINT, winnt::FILE_SHARE_READ};

use crate::{
    plugin::{LifecycleState, PluginRegistry, verify::compare_versions},
    sockscap::{module_host, paths},
};

use super::startup::process_start_filetime;

const MINIMUM_RUNTIME_MODULE: &str = "0.1.8";
const PAYLOAD: [&str; 3] = ["sockscap-helper.exe", "WinDivert.dll", "WinDivert64.sys"];
const REPARSE_POINT: u32 = 0x400;

pub(super) struct CaptureRuntime {
    pub exe: PathBuf,
    pub directory: PathBuf,
    pub owner: u32,
    pub owner_start: Option<u64>,
    // Keep writes and replacement blocked until the helper opens the driver.
    _verified_assets: Vec<File>,
}

pub(super) async fn prepare(
    app: &AppHandle,
    registry: &Arc<PluginRegistry>,
) -> Result<CaptureRuntime, String> {
    if let Some(record) = registry.get(SLUG) {
        if record.state != LifecycleState::Enabled {
            return Err("Enable the SocksCap module before starting Windows capture".into());
        }
        let version = record.manifest.version;
        if provides_capture(&version) {
            let info: RuntimeInfo =
                module_host::invoke(registry, RUNTIME_INFO, serde_json::json!({})).await?;
            let owner_start = process_start_filetime(info.host_pid)
                .ok_or("The signed SocksCap host exited before capture could start")?;
            let registry = registry.clone();
            let (directory, assets) =
                tokio::task::spawn_blocking(move || stage(&registry, &version))
                    .await
                    .map_err(|error| error.to_string())??;
            return Ok(CaptureRuntime {
                exe: directory.join(PAYLOAD[0]),
                directory,
                owner: info.host_pid,
                owner_start: Some(owner_start),
                _verified_assets: assets,
            });
        }
    }
    if !crate::is_qa_identifier(&app.config().identifier) && !cfg!(debug_assertions) {
        return Err("Install or update the SocksCap module to use Windows capture".into());
    }
    let (exe, directory) = paths::stage_privileged_runtime(app).or_else(|_| {
        let directory =
            paths::resolve_windivert_dir(app).ok_or_else(|| paths::windivert_missing_hint(app))?;
        Ok::<_, String>((paths::resolve_helper_exe(app)?, directory))
    })?;
    let owner = std::process::id();
    Ok(CaptureRuntime {
        exe,
        directory,
        owner,
        owner_start: process_start_filetime(owner),
        _verified_assets: Vec::new(),
    })
}

fn provides_capture(version: &str) -> bool {
    compare_versions(version, MINIMUM_RUNTIME_MODULE).is_ok_and(|order| order != Ordering::Less)
}

fn stage(registry: &PluginRegistry, version: &str) -> Result<(PathBuf, Vec<File>), String> {
    registry
        .with_active_package(SLUG, version, |trusted| {
            let bytes = PAYLOAD
                .iter()
                .map(|file| trusted.read_file(&format!("resources/windows/{file}")))
                .collect::<Result<Vec<_>, _>>()?;
            let mut directory = registry.root().join(SLUG);
            for name in ["runtime", "windows-capture", version] {
                directory.push(name);
                create_directory(&directory)?;
            }
            let directory = fs::canonicalize(directory)?;
            let mut assets = Vec::with_capacity(PAYLOAD.len());
            for (file, bytes) in PAYLOAD.iter().zip(bytes) {
                assets.push(stage_asset(&directory.join(file), &bytes)?);
            }
            Ok((directory, assets))
        })
        .map_err(|error| error.to_string())
}

fn stage_asset(path: &Path, expected: &[u8]) -> io::Result<File> {
    if let Some(file) = lock_matching_asset(path, expected)? {
        return Ok(file);
    }
    let directory = path.parent().expect("capture payload directory");
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    pending.write_all(expected)?;
    pending.as_file().sync_all()?;
    pending.persist(path).map_err(|error| error.error)?;
    lock_matching_asset(path, expected)?
        .ok_or_else(|| io::Error::other("SocksCap capture file changed during staging"))
}

fn lock_matching_asset(path: &Path, expected: &[u8]) -> io::Result<Option<File>> {
    let mut file = match File::options()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if metadata.file_attributes() & REPARSE_POINT != 0 || !metadata.is_file() {
        return Err(io::Error::other("Invalid SocksCap capture file"));
    }
    if metadata.len() != expected.len() as u64 {
        return Ok(None);
    }
    let mut contents = Vec::with_capacity(expected.len());
    file.read_to_end(&mut contents)?;
    Ok((contents == expected).then_some(file))
}

fn create_directory(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && metadata.file_attributes() & REPARSE_POINT == 0 {
        Ok(())
    } else {
        Err(io::Error::other(
            "Invalid SocksCap capture runtime directory",
        ))
    }
}
