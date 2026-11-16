//! Persist the exact signed catalog bytes independently of renderer lifetime.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{PluginError, current_platform, download, verify};

#[derive(Serialize, Deserialize)]
struct SignedCatalog {
    payload: String,
    signature: String,
}

const MAX_CACHED_ENVELOPE_BYTES: u64 = 12 * 1024 * 1024;

pub async fn fetch_trusted_catalog(
    service: &download::HttpDownloadService,
    url: &str,
    plugin_root: &Path,
) -> Result<download::ModuleCatalog, String> {
    let mut signature_url = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
    signature_url.set_path(&format!("{}.minisig", signature_url.path()));
    let (raw, signature) = tokio::try_join!(
        service.fetch_metadata(url, 4 * 1024 * 1024),
        service.fetch_metadata(signature_url.as_str(), 16 * 1024),
    )
    .map_err(|error| error.to_string())?;
    let signature = String::from_utf8(signature).map_err(|error| error.to_string())?;
    let plugin_root = plugin_root.to_owned();
    // Signature work, disk flushing and cross-process locks must not block a
    // Tokio worker while another app instance publishes its catalogue.
    tauri::async_runtime::spawn_blocking(move || {
        persist_trusted_catalog(raw, signature, &plugin_root)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

fn persist_trusted_catalog(
    raw: Vec<u8>,
    signature: String,
    plugin_root: &Path,
) -> Result<download::ModuleCatalog, PluginError> {
    let cache = plugin_root.join(".catalog-trust");
    let _publication = lock_publication(plugin_root, &cache)?;
    let verified = verify::VerifiedCatalog::verify(&raw, &signature, &cache)?;
    let envelope = SignedCatalog {
        payload: String::from_utf8(raw).map_err(|error| invalid(&error.to_string()))?,
        signature,
    };
    // A single atomic envelope prevents catalog/signature pairs from separate
    // refreshes being observed together. Sequence/digest checks remain inside
    // the verifier on every installation and survive application restarts.
    let mut temporary = tempfile::NamedTempFile::new_in(&cache)?;
    temporary.write_all(&serde_json::to_vec(&envelope)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(cache.join("catalog.json"))
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(cache)?.sync_all()?;
    Ok(verified.catalog().clone())
}

pub fn package_from_cached_catalog(
    archive: &Path,
    plugin_root: &Path,
    plugin_id: &str,
) -> Result<verify::VerifiedPackage, PluginError> {
    let catalog = read_cached_catalog(plugin_root)?;
    Ok(verify::VerifiedPackage::from_catalog(
        archive,
        &catalog,
        plugin_id,
        current_platform(),
    )?)
}

pub(super) fn read_cached_catalog(
    plugin_root: &Path,
) -> Result<verify::VerifiedCatalog, PluginError> {
    let cache = plugin_root.join(".catalog-trust");
    let _publication = lock_publication(plugin_root, &cache)?;
    let path = cache.join("catalog.json");
    reject_symlink(&path)?;
    reject_special_file(&path)?;
    let file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("catalogue cache must be a regular file"));
    }
    let mut raw = Vec::new();
    file.take(MAX_CACHED_ENVELOPE_BYTES + 1)
        .read_to_end(&mut raw)?;
    if raw.len() as u64 > MAX_CACHED_ENVELOPE_BYTES {
        return Err(invalid("catalogue cache exceeds 12 MiB"));
    }
    let envelope: SignedCatalog = serde_json::from_slice(&raw)?;
    Ok(verify::VerifiedCatalog::verify(
        envelope.payload.as_bytes(),
        &envelope.signature,
        &cache,
    )?)
}

/// Separate from the watermark's own lock, and always acquired first. Holding
/// this through verification and envelope publication prevents an older
/// concurrent fetch from replacing the cache after a newer watermark commits.
fn lock_publication(plugin_root: &Path, cache: &Path) -> Result<File, PluginError> {
    reject_symlink(plugin_root)?;
    fs::create_dir_all(cache)?;
    reject_symlink(cache)?;
    let path = cache.join("publication.lock");
    reject_symlink(&path)?;
    reject_special_file(&path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    lock.lock()?;
    Ok(lock)
}

fn reject_symlink(path: &Path) -> Result<(), PluginError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(invalid("catalogue cache must not contain symbolic links"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn invalid(message: &str) -> PluginError {
    verify::TrustError::Catalog(message.into()).into()
}

fn reject_special_file(path: &Path) -> Result<(), PluginError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            Err(invalid("catalogue state must be a regular file"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests;
