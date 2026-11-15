//! Package trust capabilities. Neither renderer paths nor JSON receipts can
//! construct a verified package or authorize code loading after a restart.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use tempfile::{NamedTempFile, TempDir};

use super::archive::{self, TreeDigests};
use super::catalog::{PLATFORMS, reject_symlink, valid_slug};
use super::signature::SignatureVerifier;
use super::{TrustError, TrustedComment, VerifiedCatalog, trusted_fields, verify_trusted_comment};
use crate::plugin::ModuleManifest;

const MAX_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const TRUST_DIR: &str = ".taomni-trust";
const KNOWN_PERMISSIONS: [&str; 14] = [
    "vault.ref",
    "vault.session-secret",
    "vault.fixed-key",
    "session.read",
    "network.egress",
    "fs.dataDir",
    "window.open",
    "capture.screen",
    "terminal.observe",
    "terminal.control",
    "chat.observe",
    "chat.control",
    "desktop.input",
    "backup.snapshot",
];

/// An archive snapshot with verified signature, metadata and exact tree. The
/// temporary directory and checksums are private so callers cannot turn an
/// arbitrary unpacked renderer directory into an install authorization.
#[derive(Debug)]
pub struct VerifiedPackage {
    directory: TempDir,
    archive: NamedTempFile,
    signature: String,
    pub(super) manifest: ModuleManifest,
    pub(super) checksums: TreeDigests,
}

impl VerifiedPackage {
    pub fn from_catalog(
        archive: &Path,
        catalog: &VerifiedCatalog,
        plugin_id: &str,
        platform: &str,
    ) -> Result<Self, TrustError> {
        let plugin = catalog
            .catalog()
            .plugins
            .get(plugin_id)
            .ok_or_else(|| invalid("selected module is absent from the signed catalogue"))?;
        let asset = plugin
            .platforms
            .get(platform)
            .ok_or_else(|| invalid("selected module does not support this platform"))?;
        let expected = TrustedComment {
            id: &plugin.id,
            version: &plugin.version,
            platform,
            core_api_version: &plugin.core_api_version,
            sha256: &asset.sha256,
        };
        Self::prepare(
            archive,
            &asset.signature,
            platform,
            &catalog.verifier,
            Some((&expected, asset.size)),
        )
    }

    /// Offline packages pass the same signature, metadata and content checks.
    /// Their detached signature comes from the user's local sidecar file, but
    /// the verification key always comes from the application binary.
    pub fn from_offline(
        archive: &Path,
        detached_signature: &str,
        platform: &str,
    ) -> Result<Self, TrustError> {
        Self::prepare(
            archive,
            detached_signature,
            platform,
            &SignatureVerifier::embedded()?,
            None,
        )
    }

    pub fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    pub(crate) fn directory(&self) -> &Path {
        self.directory.path()
    }

    pub(crate) fn check_contents(&self, path: &Path) -> Result<(), TrustError> {
        archive::check_tree(path, &self.checksums)
    }

    pub(crate) fn check_installed_contents(&self, path: &Path) -> Result<(), TrustError> {
        archive::check_installed_tree(path, &self.checksums)?;
        let proof = path.join(TRUST_DIR);
        reject_symlink(&proof)?;
        reject_symlink(&proof.join("package.taomni-plugin"))?;
        reject_symlink(&proof.join("signature.minisig"))?;
        let proof_digest =
            archive::hash_file(&mut File::open(proof.join("package.taomni-plugin"))?)?;
        let mut original = self.archive.reopen()?;
        let expected = archive::hash_file(&mut original)?;
        if proof_digest != expected
            || fs::read_to_string(proof.join("signature.minisig"))? != self.signature
        {
            return Err(invalid(
                "stored signature proof does not match the verified package",
            ));
        }
        Ok(())
    }

    pub(crate) fn persist_proof(&self, destination: &Path) -> Result<(), TrustError> {
        let proof = destination.join(TRUST_DIR);
        fs::create_dir(&proof)?;
        let archive = proof.join("package.taomni-plugin");
        fs::copy(self.archive.path(), &archive)?;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(archive)?
            .sync_all()?;
        let mut signature = File::create(proof.join("signature.minisig"))?;
        signature.write_all(self.signature.as_bytes())?;
        signature.sync_all()?;
        #[cfg(unix)]
        File::open(proof)?.sync_all()?;
        Ok(())
    }

    pub(super) fn prepare(
        archive_path: &Path,
        detached: &str,
        platform: &str,
        verifier: &SignatureVerifier,
        expected: Option<(&TrustedComment<'_>, u64)>,
    ) -> Result<Self, TrustError> {
        if !PLATFORMS.contains(&platform) {
            return Err(invalid("unsupported plugin platform"));
        }
        reject_symlink(archive_path)?;
        let metadata = fs::symlink_metadata(archive_path)?;
        if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES {
            return Err(invalid(
                "plugin archive must be a regular file no larger than 4 GiB",
            ));
        }
        let mut source = File::open(archive_path)?;
        if !source.metadata()?.is_file() {
            return Err(invalid("plugin archive must be a regular file"));
        }
        // Verify and unpack one private snapshot, so replacement or mutation of
        // the user-selected file cannot swap bytes after the signature check.
        let mut snapshot = NamedTempFile::new()?;
        let copied = std::io::copy(
            &mut (&mut source).take(MAX_ARCHIVE_BYTES + 1),
            &mut snapshot,
        )?;
        if copied > MAX_ARCHIVE_BYTES || expected.is_some_and(|(_, size)| copied != size) {
            return Err(invalid(
                "archive size differs from the signed catalogue or exceeds 4 GiB",
            ));
        }
        snapshot.flush()?;
        let comment = verifier.verify_file(snapshot.as_file_mut(), detached)?;
        let fields = trusted_fields(&comment)?;
        let get = |name: &str| -> Result<&str, TrustError> {
            fields
                .get(name)
                .copied()
                .ok_or_else(|| invalid(&format!("signed metadata is missing {name}")))
        };
        let id = get("id")?;
        let version = get("version")?;
        let api = get("coreApiVersion")?;
        let sha256 = get("sha256")?;
        if get("platform")? != platform || api != crate::plugin::CORE_API_VERSION {
            return Err(invalid(
                "signed package platform or coreApiVersion is incompatible",
            ));
        }
        let slug = id
            .strip_prefix("taomni-plugin-")
            .filter(|slug| valid_slug(slug))
            .ok_or_else(|| invalid("signed plugin id is invalid"))?;
        super::compare_versions(version, version)?;
        snapshot.as_file_mut().seek(SeekFrom::Start(0))?;
        let actual_sha = archive::hash_file(snapshot.as_file_mut())?;
        if sha256 != actual_sha {
            return Err(invalid(
                "archive SHA-256 does not match its signed metadata",
            ));
        }
        if let Some((expected, _)) = expected {
            verify_trusted_comment(&comment, expected)?;
        }
        snapshot.as_file_mut().seek(SeekFrom::Start(0))?;
        let directory = tempfile::tempdir()?;
        let checksums = archive::extract(snapshot.as_file_mut(), directory.path())?;
        let mut raw_manifest = Vec::new();
        File::open(directory.path().join("module.json"))?
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut raw_manifest)?;
        if raw_manifest.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(invalid("module.json exceeds 2 MiB"));
        }
        let manifest: ModuleManifest = serde_json::from_slice(&raw_manifest)?;
        if manifest.id != id
            || manifest.slug != slug
            || manifest.version != version
            || manifest.core_api_version != api
            || !manifest.platforms.contains(platform)
            || manifest
                .platforms
                .iter()
                .any(|value| !PLATFORMS.contains(&value.as_str()))
            || manifest.data_dir != format!("plugins/{slug}")
        {
            return Err(invalid(
                "module.json does not match the signed package identity",
            ));
        }
        if manifest.entry.protocol != taomni_plugin_api::RPC_PROTOCOL_VERSION as u16 {
            return Err(invalid("module.json has an incompatible RPC protocol"));
        }
        if manifest
            .permissions
            .iter()
            .any(|permission| !KNOWN_PERMISSIONS.contains(&permission.as_str()))
        {
            return Err(invalid(
                "module.json declares a permission unknown to this core",
            ));
        }
        for entry in [&manifest.entry.host, &manifest.entry.frontend]
            .into_iter()
            .flatten()
        {
            archive::validate_path(entry)?;
            if !checksums.contains_key(entry) {
                return Err(invalid("module entry is absent from the signed file tree"));
            }
        }
        for entry in &manifest.backup_paths {
            archive::validate_path(entry)?;
        }
        Ok(Self {
            directory,
            archive: snapshot,
            signature: detached.to_owned(),
            manifest,
            checksums,
        })
    }
}

/// Re-establish trust before scanning, enabling, rollback or code loading.
/// A forged receipt JSON is insufficient: retain and verify the actual signed
/// archive, then compare every installed payload byte with that archive.
pub fn verify_installed(path: &Path, platform: &str) -> Result<ModuleManifest, TrustError> {
    verify_installed_with(path, platform, &SignatureVerifier::embedded()?)
}

pub(super) fn verify_installed_with(
    path: &Path,
    platform: &str,
    verifier: &SignatureVerifier,
) -> Result<ModuleManifest, TrustError> {
    Ok(inspect_installed_with(path, platform, verifier)?.manifest)
}

pub(super) fn inspect_installed_with(
    path: &Path,
    platform: &str,
    verifier: &SignatureVerifier,
) -> Result<VerifiedPackage, TrustError> {
    // The immutable version itself, its `versions`, slug and plugin-root
    // directories are part of the trust boundary, not just the leaf files.
    for ancestor in path.ancestors().take(4) {
        reject_symlink(ancestor)?;
    }
    let proof = path.join(TRUST_DIR);
    reject_symlink(&proof)?;
    let signature_path = proof.join("signature.minisig");
    reject_symlink(&signature_path)?;
    if !fs::symlink_metadata(&signature_path)?.is_file() {
        return Err(invalid("signature proof must be a regular file"));
    }
    let mut signature = String::new();
    File::open(signature_path)?
        .take(16 * 1024 + 1)
        .read_to_string(&mut signature)?;
    let verified = VerifiedPackage::prepare(
        &proof.join("package.taomni-plugin"),
        &signature,
        platform,
        verifier,
        None,
    )?;
    archive::check_installed_tree(path, &verified.checksums)?;
    Ok(verified)
}

pub fn host_platform() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )))]
    {
        "unsupported"
    }
}

fn invalid(message: &str) -> TrustError {
    TrustError::Package(message.to_owned())
}
