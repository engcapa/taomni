//! Reusable signed file identities for serving immutable frontend assets.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::plugin::ModuleManifest;

use super::archive::{TreeDigests, validate_path};
use super::catalog::reject_symlink;
use super::package::inspect_installed_with;
use super::signature::SignatureVerifier;
use super::{TrustError, sha256_hex};

const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;

/// Cache this only for the immutable version directory. The constructor
/// authenticates its signed package and full tree once; each actual asset
/// read still checks the bytes against the authenticated hash, closing the
/// mutation gap without re-extracting a potentially large archive per GET.
#[derive(Debug, Clone)]
pub struct InstalledTrust {
    directory: PathBuf,
    manifest: ModuleManifest,
    checksums: TreeDigests,
}

impl InstalledTrust {
    pub fn verify(directory: &Path, platform: &str) -> Result<Self, TrustError> {
        let package = inspect_installed_with(directory, platform, &SignatureVerifier::embedded()?)?;
        Ok(Self {
            directory: directory.to_owned(),
            manifest: package.manifest,
            checksums: package.checksums,
        })
    }

    pub fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn contains_file(&self, relative: &str) -> bool {
        self.checksums.contains_key(relative)
    }

    /// `relative` is relative to the version directory, e.g.
    /// `frontend/index.js`. The returned bytes are exactly those hashed here;
    /// callers must not reopen the file after this method succeeds.
    pub fn read_file(&self, relative: &str) -> Result<Vec<u8>, TrustError> {
        validate_path(relative)?;
        let expected = self.checksums.get(relative).ok_or_else(|| {
            TrustError::Package("asset is absent from the signed file tree".into())
        })?;
        for ancestor in self.directory.ancestors().take(4) {
            reject_symlink(ancestor)?;
        }
        let mut path = self.directory.clone();
        for component in relative.split('/') {
            path.push(component);
            reject_symlink(&path)?;
        }
        let mut file = File::open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > MAX_ASSET_BYTES {
            return Err(TrustError::Package(
                "asset is not a regular file or exceeds 256 MiB".into(),
            ));
        }
        let canonical = fs::canonicalize(&path)?;
        if !canonical.starts_with(fs::canonicalize(&self.directory)?) {
            return Err(TrustError::Package(
                "asset escapes the verified version directory".into(),
            ));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_ASSET_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ASSET_BYTES || sha256_hex(&bytes) != *expected {
            return Err(TrustError::Package(
                "asset bytes differ from the signed package".into(),
            ));
        }
        Ok(bytes)
    }
}
