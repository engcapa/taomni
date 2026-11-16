//! Authenticated catalogue state, including a durable anti-rollback watermark.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::signature::SignatureVerifier;
use super::{TrustError, compare_versions, sha256_hex, validate_sequence};
use crate::plugin::download::ModuleCatalog;

const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
pub(super) const PLATFORMS: [&str; 4] = [
    "linux-x86_64",
    "windows-x86_64",
    "darwin-x86_64",
    "darwin-aarch64",
];

/// Only the signature adapter can create this value. Passing a deserialized
/// `ModuleCatalog` from the renderer never establishes package trust.
#[derive(Debug, Clone)]
pub struct VerifiedCatalog {
    catalog: ModuleCatalog,
    pub(super) verifier: SignatureVerifier,
}

impl VerifiedCatalog {
    pub fn verify(
        raw: &[u8],
        detached_signature: &str,
        cache_dir: &Path,
    ) -> Result<Self, TrustError> {
        Self::verify_with(
            raw,
            detached_signature,
            cache_dir,
            SignatureVerifier::embedded()?,
        )
    }

    pub fn catalog(&self) -> &ModuleCatalog {
        &self.catalog
    }

    pub(super) fn verify_with(
        raw: &[u8],
        detached_signature: &str,
        cache_dir: &Path,
        verifier: SignatureVerifier,
    ) -> Result<Self, TrustError> {
        if raw.len() > MAX_CATALOG_BYTES {
            return Err(TrustError::Catalog("catalogue exceeds 8 MiB".into()));
        }
        verifier.verify_bytes(raw, detached_signature)?;
        let catalog: ModuleCatalog = serde_json::from_slice(raw)?;
        catalog
            .validate(crate::plugin::CORE_API_VERSION)
            .map_err(|error| TrustError::Catalog(error.to_string()))?;
        for plugin in catalog.plugins.values() {
            if !valid_slug(&plugin.slug) || plugin.name.trim().is_empty() {
                return Err(TrustError::Catalog("invalid module slug/name".into()));
            }
            compare_versions(&plugin.version, &plugin.version)?;
            if plugin.permissions.as_ref().is_some_and(|permissions| {
                permissions.iter().any(|permission| {
                    !super::package::KNOWN_PERMISSIONS.contains(&permission.as_str())
                })
            }) {
                return Err(TrustError::Catalog(
                    "catalogue declares unknown module permissions".into(),
                ));
            }
            for (platform, asset) in &plugin.platforms {
                if !PLATFORMS.contains(&platform.as_str()) || asset.size == 0 {
                    return Err(TrustError::Catalog("invalid platform/asset size".into()));
                }
            }
        }
        record_sequence(cache_dir, catalog.sequence, &sha256_hex(raw))?;
        Ok(Self { catalog, verifier })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SequenceWatermark {
    sequence: u64,
    sha256: String,
}

fn record_sequence(cache_dir: &Path, sequence: u64, digest: &str) -> Result<(), TrustError> {
    fs::create_dir_all(cache_dir)?;
    reject_symlink(cache_dir)?;
    let lock_path = cache_dir.join("catalog.lock");
    reject_symlink(&lock_path)?;
    reject_special_file(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    // The lock covers read, comparison and atomic publication across app
    // instances sharing the profile, so concurrent fetches cannot lower it.
    lock.lock()?;
    let path = cache_dir.join("catalog-sequence.json");
    reject_symlink(&path)?;
    reject_special_file(&path)?;
    let previous: Option<SequenceWatermark> = match File::open(&path) {
        Ok(file) => {
            if !file.metadata()?.is_file() {
                return Err(TrustError::Catalog(
                    "catalogue watermark must be a regular file".into(),
                ));
            }
            let mut raw = Vec::new();
            file.take(4097).read_to_end(&mut raw)?;
            if raw.len() > 4096 {
                return Err(TrustError::Catalog(
                    "catalogue watermark exceeds 4 KiB".into(),
                ));
            }
            Some(serde_json::from_slice(&raw)?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    validate_sequence(previous.as_ref().map(|state| state.sequence), sequence)?;
    if let Some(previous) = previous {
        if previous.sequence == sequence {
            if previous.sha256 != digest {
                return Err(TrustError::Catalog(
                    "catalogue sequence was reused with different contents".into(),
                ));
            }
            return Ok(());
        }
    }
    let mut temporary = tempfile::NamedTempFile::new_in(cache_dir)?;
    temporary.write_all(&serde_json::to_vec(&SequenceWatermark {
        sequence,
        sha256: digest.to_owned(),
    })?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| TrustError::Io(error.error))?;
    #[cfg(unix)]
    File::open(cache_dir)?.sync_all()?;
    Ok(())
}

pub(super) fn reject_symlink(path: &Path) -> Result<(), TrustError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(TrustError::Package(format!(
            "symbolic links are not allowed: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn reject_special_file(path: &Path) -> Result<(), TrustError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => Err(TrustError::Catalog(
            "catalogue state must be a regular file".into(),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}
