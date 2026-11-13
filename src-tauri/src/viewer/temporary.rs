//! Artifact ownership outlives views. Only exact registered paths/tokens release
//! TempDirs; callers never supply a deletion root. Exit drains the registry.
use super::paths::{display, file_name, io_error};
use super::{HARD_BYTES, TempFile};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

struct OwnedTemp {
    directory: tempfile::TempDir,
    path: PathBuf,
}

fn registry() -> &'static Mutex<HashMap<String, OwnedTemp>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, OwnedTemp>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

pub(crate) fn create_temp(file_name_input: &str, bytes: &[u8]) -> Result<TempFile, String> {
    let file_name = file_name(file_name_input)?;
    if bytes.len() as u64 > HARD_BYTES {
        return Err("too_large: Temp copy exceeds 64 MiB".into());
    }
    let directory = tempfile::Builder::new()
        .prefix("taomni-viewer-")
        .tempdir()
        .map_err(|error| io_error("allocate viewer temp directory", error))?;
    let path = directory.path().join(file_name);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| io_error("create viewer temp file", error))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| io_error("write viewer temp file", error))?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let result = TempFile {
        path: display(&path),
        token: token.clone(),
    };
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(token, OwnedTemp { directory, path });
    Ok(result)
}

pub(crate) fn allocate_temp(file_name: &str) -> Result<TempFile, String> {
    create_temp(file_name, &[])
}

pub(super) fn is_owned_temp(path: &std::path::Path) -> bool {
    let canonical = path.canonicalize().ok();
    let candidates = registry().lock().unwrap_or_else(|error| error.into_inner());
    candidates.values().any(|artifact| {
        artifact.path == path
            || canonical.as_ref().is_some_and(|candidate| {
                artifact
                    .path
                    .canonicalize()
                    .is_ok_and(|owned| owned == *candidate)
            })
    })
}

pub(crate) fn release_temp(path: &str) -> Result<(), String> {
    let mut owned = registry().lock().unwrap_or_else(|error| error.into_inner());
    let token = owned
        .iter()
        .find(|(_, value)| display(&value.path) == path)
        .map(|(token, _)| token.clone());
    if let Some(token) = token {
        let artifact = owned.remove(&token).unwrap();
        artifact
            .directory
            .close()
            .map_err(|error| io_error("release viewer temp file", error))?;
        Ok(())
    } else {
        Err("permission: Path is not an owned viewer temp copy".into())
    }
}

pub(crate) fn release_temp_token(token: &str) -> Result<(), String> {
    let artifact = registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(token);
    match artifact {
        Some(artifact) => artifact
            .directory
            .close()
            .map_err(|error| io_error("release viewer temp file", error)),
        None => Err("permission: Unknown viewer temp token".into()),
    }
}

pub(crate) fn shutdown() {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
    super::html::clear();
}
