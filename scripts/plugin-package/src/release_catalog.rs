//! Verify staged packages before authenticating the exact public catalog bytes.
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    PLATFORMS,
    signing::{ReleaseSigner, public_verifier, verify_file, verify_reader},
};

mod update;
pub use update::{prepare_catalog_update, prepare_catalog_update_rehearsal};

const CATALOG: &str = "modules.json";
const SIGNATURE: &str = "modules.json.minisig";
const MAX_CATALOG: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum StatusPolicy {
    StableOnly,
    RehearsalAllowProvisional,
}

pub fn sign_staged(directory: &Path) -> Result<()> {
    sign_staged_with_policy(directory, StatusPolicy::StableOnly)
}

pub fn sign_staged_rehearsal(directory: &Path) -> Result<()> {
    sign_staged_with_policy(directory, StatusPolicy::RehearsalAllowProvisional)
}

fn sign_staged_with_policy(directory: &Path, policy: StatusPolicy) -> Result<()> {
    let verifier = public_verifier()?;
    let catalog = inspect_with_policy(directory, &verifier, policy)?;
    let signer = ReleaseSigner::from_environment()?;
    let signature = signer.sign(&catalog.path, &catalog.comment())?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(signature.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(directory.join(SIGNATURE))?;
    Ok(())
}

pub fn verify_staged(directory: &Path) -> Result<()> {
    let verifier = public_verifier()?;
    inspect_signed_with_policy(directory, &verifier, StatusPolicy::StableOnly).map(|_| ())
}

pub fn verify_staged_rehearsal(directory: &Path) -> Result<()> {
    let verifier = public_verifier()?;
    inspect_signed_with_policy(
        directory,
        &verifier,
        StatusPolicy::RehearsalAllowProvisional,
    )
    .map(|_| ())
}

/// Verify a published catalog before copying its exact bytes to a new core
/// release. The asset URLs still refer to the original packages.
pub fn verify_catalog_signature(directory: &Path) -> Result<()> {
    read_signed_catalog(directory, &public_verifier()?).map(|_| ())
}

pub fn verify_release_roster(directory: &Path, previous: Option<&Path>) -> Result<()> {
    check_release_roster(directory, previous, &public_verifier()?)
}

fn check_release_roster(
    directory: &Path,
    previous: Option<&Path>,
    verifier: &minisign_verify::PublicKey,
) -> Result<()> {
    let catalog = read_catalog(directory)?;
    let roster = validated_roster(&catalog.document)?;
    if let Some(directory) = previous {
        let previous = read_signed_catalog(directory, verifier)?;
        ensure!(
            roster == validated_roster(&previous.document)?,
            "the published first-upgrade roster must be preserved"
        );
        ensure!(
            catalog.raw == previous.raw || catalog.sequence > previous.sequence,
            "a changed module catalog needs a higher sequence"
        );
    } else {
        ensure!(
            roster.len() == catalog_plugins(&catalog.document)?.len(),
            "the first-upgrade roster must include every module in the first release"
        );
    }
    Ok(())
}

pub(crate) struct Catalog {
    pub(crate) path: PathBuf,
    sequence: u64,
    pub(crate) document: Value,
    raw: String,
}

impl Catalog {
    fn comment(&self) -> String {
        format!("file={CATALOG} sequence={}", self.sequence)
    }
}

fn read_catalog(directory: &Path) -> Result<Catalog> {
    let path = directory.join(CATALOG);
    let raw = read_text(&path, MAX_CATALOG)?;
    let document: Value = serde_json::from_str(&raw)?;
    let sequence = document["sequence"]
        .as_u64()
        .filter(|n| *n > 0)
        .context("invalid module catalog sequence")?;
    if let Some(exceptions) = document.get("releaseExceptions") {
        let exceptions = exceptions
            .as_object()
            .context("invalid module release exceptions")?;
        for (id, exception) in exceptions {
            ensure!(
                id == "taomni-plugin-mobile"
                    && document["plugins"].get(id).is_none()
                    && exception["placement"] == "core"
                    && exception["name"] == "Mobile"
                    && exception["notes"]
                        .as_str()
                        .is_some_and(|notes| !notes.trim().is_empty()),
                "invalid module release exception for {id}"
            );
        }
    }
    Ok(Catalog {
        path,
        sequence,
        document,
        raw,
    })
}

fn inspect(directory: &Path, verifier: &minisign_verify::PublicKey) -> Result<Catalog> {
    inspect_with_policy(directory, verifier, StatusPolicy::StableOnly)
}

pub(crate) fn inspect_with_policy(
    directory: &Path,
    verifier: &minisign_verify::PublicKey,
    policy: StatusPolicy,
) -> Result<Catalog> {
    let catalog = read_catalog(directory)?;
    validated_roster(&catalog.document)?;
    verify_packages_with_policy(directory, verifier, &catalog.document, policy)?;
    Ok(catalog)
}

fn inspect_signed(directory: &Path, verifier: &minisign_verify::PublicKey) -> Result<Catalog> {
    inspect_signed_with_policy(directory, verifier, StatusPolicy::StableOnly)
}

pub(crate) fn inspect_signed_with_policy(
    directory: &Path,
    verifier: &minisign_verify::PublicKey,
    policy: StatusPolicy,
) -> Result<Catalog> {
    let catalog = read_signed_catalog(directory, verifier)?;
    verify_packages_with_policy(directory, verifier, &catalog.document, policy)?;
    Ok(catalog)
}

fn read_signed_catalog(directory: &Path, verifier: &minisign_verify::PublicKey) -> Result<Catalog> {
    let catalog = read_catalog(directory)?;
    let signature = read_text(&directory.join(SIGNATURE), 16 * 1024)?;
    verify_reader(
        verifier,
        catalog.raw.as_bytes(),
        &signature,
        &catalog.comment(),
    )?;
    validated_roster(&catalog.document)?;
    Ok(catalog)
}

fn catalog_plugins(doc: &Value) -> Result<&serde_json::Map<String, Value>> {
    doc["plugins"]
        .as_object()
        .filter(|plugins| !plugins.is_empty())
        .context("empty module catalog")
}

fn validated_roster(doc: &Value) -> Result<BTreeSet<&str>> {
    let plugins = catalog_plugins(doc)?;
    let roster = doc["legacyUpgrade"]
        .as_array()
        .context("release catalog requires the first-upgrade roster")?;
    ensure!(!roster.is_empty(), "first-upgrade roster is empty");
    let mut seen = BTreeSet::new();
    for id in roster {
        let id = id.as_str().context("invalid first-upgrade module ID")?;
        ensure!(
            plugins.contains_key(id) && seen.insert(id),
            "first-upgrade module ID is absent or repeated"
        );
    }
    Ok(seen)
}

pub(crate) fn verify_packages_with_policy(
    directory: &Path,
    verifier: &minisign_verify::PublicKey,
    doc: &Value,
    policy: StatusPolicy,
) -> Result<()> {
    let api = crate::string(doc, "coreApiVersion")?;
    let plugins = catalog_plugins(doc)?;
    for (id, plugin) in plugins {
        let slug = crate::string(plugin, "slug")?;
        ensure!(
            crate::valid_slug(slug)
                && id == &format!("taomni-plugin-{slug}")
                && slug != "lanchat"
                && slug != "hello-plugin",
            "invalid release module identity"
        );
        ensure!(
            crate::string(plugin, "id")? == id && crate::string(plugin, "coreApiVersion")? == api,
            "catalog identity or API mismatch for {id}"
        );
        let version = crate::string(plugin, "version")?;
        semver::Version::parse(version)?;
        let assets = plugin["platforms"]
            .as_object()
            .filter(|assets| !assets.is_empty())
            .context("module has no platform assets")?;
        for (platform, asset) in assets {
            ensure!(
                PLATFORMS.contains(&platform.as_str()),
                "unsupported module platform: {platform}"
            );
            verify_asset(
                directory, verifier, plugin, version, platform, asset, policy,
            )?;
        }
    }
    Ok(())
}

fn verify_asset(
    directory: &Path,
    verifier: &minisign_verify::PublicKey,
    plugin: &Value,
    version: &str,
    platform: &str,
    asset: &Value,
    policy: StatusPolicy,
) -> Result<()> {
    let id = crate::string(plugin, "id")?;
    let filename = format!("{id}-{version}-{platform}.taomni-plugin");
    let path = directory.join(&filename);
    let url = crate::string(asset, "url")?;
    ensure!(
        url.starts_with("https://github.com/")
            && url.contains("/releases/download/")
            && url.rsplit('/').next() == Some(filename.replace('+', "%2B").as_str()),
        "catalog URL names a different package: {id}"
    );
    let metadata = fs::symlink_metadata(&path)?;
    let size = asset["size"]
        .as_u64()
        .filter(|bytes| *bytes > 0)
        .context("invalid module size")?;
    ensure!(
        metadata.is_file() && metadata.len() == size,
        "staged module size mismatch: {filename}"
    );
    let sha = crate::string(asset, "sha256")?;
    let mut digest = Sha256::new();
    std::io::copy(&mut File::open(&path)?, &mut digest)?;
    ensure!(
        format!("{:x}", digest.finalize()) == sha,
        "staged module hash mismatch: {filename}"
    );
    let signature = read_text(&directory.join(format!("{filename}.minisig")), 16 * 1024)?;
    ensure!(
        signature.trim() == crate::string(asset, "signature")?.trim(),
        "catalog signature mismatch: {filename}"
    );
    let api = crate::string(plugin, "coreApiVersion")?;
    verify_file(
        verifier,
        &path,
        &signature,
        &format!("id={id} version={version} platform={platform} coreApiVersion={api} sha256={sha}"),
    )?;
    let mut archive = zip::ZipArchive::new(File::open(path)?)?;
    let entry = archive.by_name("module.json")?;
    ensure!(
        entry.size() <= 128 * 1024,
        "module manifest is too large: {filename}"
    );
    let manifest: Value = serde_json::from_reader(entry)?;
    let description = crate::string(&manifest, "description")?.trim();
    let status_ok = match policy {
        StatusPolicy::StableOnly => manifest["status"] == "stable",
        StatusPolicy::RehearsalAllowProvisional => {
            matches!(manifest["status"].as_str(), Some("stable" | "provisional"))
        }
    };
    ensure!(
        status_ok && !description.is_empty(),
        "release module must be stable and described: {id}"
    );
    for key in [
        "id",
        "slug",
        "version",
        "name",
        "coreApiVersion",
        "kind",
        "document",
    ] {
        ensure!(
            manifest[key] == plugin[key],
            "signed package metadata differs for {id}/{key}"
        );
    }
    let declared = manifest["platforms"]
        .as_array()
        .context("module manifest has no platform list")?;
    let declared: BTreeSet<_> = declared
        .iter()
        .map(|value| value.as_str().context("invalid manifest platform"))
        .collect::<Result<_>>()?;
    let published: BTreeSet<_> = plugin["platforms"]
        .as_object()
        .context("invalid catalog platform list")?
        .keys()
        .map(String::as_str)
        .collect();
    ensure!(
        declared == published,
        "release does not contain all declared platforms for {id}"
    );
    let permissions = |value: &Value| {
        value
            .get("permissions")
            .or_else(|| value.get("documentPermissions"))
            .and_then(Value::as_array)
            .map(|items| {
                let mut items = items.clone();
                items.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
                items
            })
    };
    ensure!(
        description == crate::string(plugin, "description")?
            && permissions(&manifest) == permissions(plugin),
        "signed package description or permissions differ for {id}"
    );
    Ok(())
}

fn read_text(path: &Path, limit: u64) -> Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && metadata.len() <= limit,
        "invalid release file: {}",
        path.display()
    );
    let mut text = String::new();
    File::open(path)?
        .take(limit + 1)
        .read_to_string(&mut text)?;
    ensure!(
        text.len() as u64 <= limit,
        "release file exceeds its byte limit"
    );
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stage(root: &Path, signer: &ReleaseSigner) -> (PathBuf, Value) {
        stage_module(root, signer, "mfa", "1.1.0", "v0.6.0")
    }

    pub(super) fn stage_module(
        root: &Path,
        signer: &ReleaseSigner,
        slug: &str,
        version: &str,
        tag: &str,
    ) -> (PathBuf, Value) {
        stage_module_with_status(
            root,
            signer,
            slug,
            version,
            tag,
            "stable",
            "Generate time-based codes",
        )
    }

    pub(super) fn stage_module_with_status(
        root: &Path,
        signer: &ReleaseSigner,
        slug: &str,
        version: &str,
        tag: &str,
        status: &str,
        description: &str,
    ) -> (PathBuf, Value) {
        let payload = root.join("input");
        fs::create_dir_all(&payload).unwrap();
        fs::write(payload.join("host"), b"sample execution payload").unwrap();
        let id = format!("taomni-plugin-{slug}");
        let platform = "linux-x86_64";
        let manifest = json!({
            "id": id, "slug": slug, "name": slug, "version": version, "coreApiVersion": "1",
            "description": description, "status": status, "kind": "auth",
            "platforms": [platform], "entry": {"host": "host"}, "permissions": ["vault.fixed-key"]
        });
        fs::write(
            payload.join("module.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let staged = root.join("staged");
        let receipt = crate::package(&payload, platform, &staged, &"a".repeat(40), signer).unwrap();
        let name = receipt["archive"].as_str().unwrap();
        let signature =
            fs::read_to_string(staged.join(receipt["signature"].as_str().unwrap())).unwrap();
        let mut module = manifest;
        module["platforms"] = json!({(platform): {
            "url": format!("https://github.com/engcapa/taomni/releases/download/{tag}/{name}"),
            "signature": signature, "sha256": receipt["sha256"], "size": receipt["size"]
        }});
        let catalog = json!({"sequence": 21, "coreApiVersion": "1", "legacyUpgrade": [id],
            "updatedAt": "2026-11-19T00:00:00Z", "plugins": {(id): module}});
        fs::write(staged.join(CATALOG), serde_json::to_vec(&catalog).unwrap()).unwrap();
        (staged, catalog)
    }

    #[test]
    fn signs_exact_staged_catalog_after_binding_package_bytes_and_description() {
        let root = tempfile::tempdir().unwrap();
        let signer = ReleaseSigner::test_key();
        let (staged, mut doc) = stage(root.path(), &signer);
        let catalog = inspect(&staged, signer.test_verifier()).unwrap();
        let signature = signer.sign(&catalog.path, &catalog.comment()).unwrap();
        verify_file(
            signer.test_verifier(),
            &catalog.path,
            &signature,
            &catalog.comment(),
        )
        .unwrap();
        doc["plugins"]["taomni-plugin-mfa"]["description"] = json!("Untrusted replacement");
        fs::write(&catalog.path, serde_json::to_vec(&doc).unwrap()).unwrap();
        assert!(
            verify_file(
                signer.test_verifier(),
                &catalog.path,
                &signature,
                &catalog.comment()
            )
            .is_err()
        );
        assert!(
            inspect(&staged, signer.test_verifier())
                .err()
                .unwrap()
                .to_string()
                .contains("description")
        );
    }

    #[test]
    fn rejects_wrong_roster_and_package_bytes_before_catalog_signing() {
        let root = tempfile::tempdir().unwrap();
        let signer = ReleaseSigner::test_key();
        let (staged, mut doc) = stage(root.path(), &signer);
        doc["legacyUpgrade"] = json!(["taomni-plugin-missing"]);
        let path = staged.join(CATALOG);
        fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
        assert!(
            inspect(&staged, signer.test_verifier())
                .err()
                .unwrap()
                .to_string()
                .contains("absent")
        );
        doc["legacyUpgrade"] = json!(["taomni-plugin-mfa"]);
        fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
        let package = staged.join("taomni-plugin-mfa-1.1.0-linux-x86_64.taomni-plugin");
        let mut bytes = fs::read(&package).unwrap();
        bytes[0] ^= 1;
        fs::write(package, bytes).unwrap();
        assert!(
            inspect(&staged, signer.test_verifier())
                .err()
                .unwrap()
                .to_string()
                .contains("hash mismatch")
        );
    }

    #[test]
    fn verifies_exact_published_catalog_bytes_without_restaging_unchanged_packages() {
        let root = tempfile::tempdir().unwrap();
        let signer = ReleaseSigner::test_key();
        let (staged, _) = stage(root.path(), &signer);
        let catalog = inspect(&staged, signer.test_verifier()).unwrap();
        let signature = signer.sign(&catalog.path, &catalog.comment()).unwrap();
        let published = root.path().join("published");
        fs::create_dir(&published).unwrap();
        fs::copy(catalog.path, published.join(CATALOG)).unwrap();
        fs::write(published.join(SIGNATURE), signature).unwrap();
        let verified = read_signed_catalog(&published, signer.test_verifier()).unwrap();
        assert_eq!(verified.raw, catalog.raw);
        assert!(inspect_signed(&published, signer.test_verifier()).is_err());
        fs::write(published.join(CATALOG), format!("{}\n", catalog.raw)).unwrap();
        assert!(read_signed_catalog(&published, signer.test_verifier()).is_err());
    }

    #[test]
    fn first_release_includes_every_module_and_later_releases_keep_the_signed_roster() {
        let root = tempfile::tempdir().unwrap();
        let signer = ReleaseSigner::test_key();
        let verifier = signer.test_verifier();
        let (published, original) = stage(root.path(), &signer);
        let verified = read_catalog(&published).unwrap();
        let signature = signer.sign(&verified.path, &verified.comment()).unwrap();
        fs::write(published.join(SIGNATURE), signature).unwrap();
        check_release_roster(&published, None, verifier).unwrap();
        check_release_roster(&published, Some(&published), verifier).unwrap();

        let staged = root.path().join("candidate");
        fs::create_dir(&staged).unwrap();
        let mut next = original.clone();
        next["plugins"]["taomni-plugin-vnc-client"] = json!({});
        fs::write(staged.join(CATALOG), serde_json::to_vec(&next).unwrap()).unwrap();
        let omitted = check_release_roster(&staged, None, verifier).unwrap_err();
        assert!(omitted.to_string().contains("every module"));
        let repeated = check_release_roster(&staged, Some(&published), verifier).unwrap_err();
        assert!(repeated.to_string().contains("higher sequence"));

        next["sequence"] = 22.into();
        fs::write(staged.join(CATALOG), serde_json::to_vec(&next).unwrap()).unwrap();
        check_release_roster(&staged, Some(&published), verifier).unwrap();

        next["legacyUpgrade"] = json!(["taomni-plugin-mfa", "taomni-plugin-vnc-client"]);
        fs::write(staged.join(CATALOG), serde_json::to_vec(&next).unwrap()).unwrap();
        check_release_roster(&staged, None, verifier).unwrap();
        let changed = check_release_roster(&staged, Some(&published), verifier).unwrap_err();
        assert!(
            changed
                .to_string()
                .contains("published first-upgrade roster")
        );

        fs::write(&verified.path, format!("{}\n", verified.raw)).unwrap();
        let corrupt = check_release_roster(&staged, Some(&published), verifier).unwrap_err();
        assert!(corrupt.to_string().contains("signature"));
    }

    #[test]
    fn provisional_packages_require_rehearsal_policy_while_invalid_descriptions_and_experimental_stay_rejected()
     {
        let signer = ReleaseSigner::test_key();
        let verifier = signer.test_verifier();

        let root = tempfile::tempdir().unwrap();
        let (provisional, _) = stage_module_with_status(
            root.path(),
            &signer,
            "mfa",
            "1.1.0",
            "v0.6.0",
            "provisional",
            "Generate time-based codes",
        );
        assert!(inspect(&provisional, verifier).is_err());
        assert!(inspect_with_policy(&provisional, verifier, StatusPolicy::StableOnly).is_err());
        inspect_with_policy(
            &provisional,
            verifier,
            StatusPolicy::RehearsalAllowProvisional,
        )
        .unwrap();

        let empty_desc = tempfile::tempdir().unwrap();
        let (blank, _) = stage_module_with_status(
            empty_desc.path(),
            &signer,
            "mfa",
            "1.1.0",
            "v0.6.0",
            "provisional",
            "   ",
        );
        assert!(
            inspect_with_policy(&blank, verifier, StatusPolicy::RehearsalAllowProvisional).is_err()
        );

        let experimental_dir = tempfile::tempdir().unwrap();
        let (experimental, _) = stage_module_with_status(
            experimental_dir.path(),
            &signer,
            "mfa",
            "1.1.0",
            "v0.6.0",
            "experimental",
            "Generate time-based codes",
        );
        assert!(
            inspect_with_policy(
                &experimental,
                verifier,
                StatusPolicy::RehearsalAllowProvisional,
            )
            .is_err()
        );
    }
}
