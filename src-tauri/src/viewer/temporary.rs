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

fn matches_owned_path(
    owned_path: &std::path::Path,
    candidate: &std::path::Path,
    candidate_canonical: Option<&PathBuf>,
    allow_leaf_symlink: bool,
) -> bool {
    if owned_path == candidate || display(owned_path) == candidate.to_string_lossy() {
        return true;
    }
    if !allow_leaf_symlink
        && std::fs::symlink_metadata(candidate)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return false;
    }
    candidate_canonical.is_some_and(|resolved| {
        owned_path
            .canonicalize()
            .is_ok_and(|owned| owned == *resolved)
    })
}

pub(crate) fn is_owned_temp(path: &std::path::Path) -> bool {
    let canonical = path.canonicalize().ok();
    let candidates = registry().lock().unwrap_or_else(|error| error.into_inner());
    candidates
        .values()
        .any(|artifact| matches_owned_path(&artifact.path, path, canonical.as_ref(), true))
}

pub(crate) fn release_temp(path: &str) -> Result<(), String> {
    let candidate = std::path::Path::new(path);
    let canonical = candidate.canonicalize().ok();
    let mut owned = registry().lock().unwrap_or_else(|error| error.into_inner());
    let token = owned
        .iter()
        .find(|(_, value)| matches_owned_path(&value.path, candidate, canonical.as_ref(), false))
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
    super::media_stream::clear();
}
