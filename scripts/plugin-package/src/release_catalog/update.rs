use std::{fs, path::Path};

use anyhow::{Context, Result, ensure};
use semver::Version;

use super::{
    CATALOG, StatusPolicy, catalog_plugins, inspect_signed_with_policy, inspect_with_policy,
    public_verifier, read_catalog, verify_packages_with_policy,
};

/// Prepare a complete catalog for a release of only the selected modules.
/// Return the names of the new immutable assets to upload before publication.
pub fn prepare_catalog_update(
    previous: &Path,
    changed: &Path,
    output: &Path,
) -> Result<Vec<String>> {
    prepare_with_policy(
        previous,
        changed,
        output,
        &public_verifier()?,
        StatusPolicy::StableOnly,
    )
}

/// Rehearsal-only delta preparation permitting signed provisional packages.
pub fn prepare_catalog_update_rehearsal(
    previous: &Path,
    changed: &Path,
    output: &Path,
) -> Result<Vec<String>> {
    prepare_with_policy(
        previous,
        changed,
        output,
        &public_verifier()?,
        StatusPolicy::RehearsalAllowProvisional,
    )
}

fn prepare(
    previous: &Path,
    changed: &Path,
    output: &Path,
    verifier: &minisign_verify::PublicKey,
) -> Result<Vec<String>> {
    prepare_with_policy(
        previous,
        changed,
        output,
        verifier,
        StatusPolicy::StableOnly,
    )
}

fn prepare_with_policy(
    previous: &Path,
    changed: &Path,
    output: &Path,
    verifier: &minisign_verify::PublicKey,
    policy: StatusPolicy,
) -> Result<Vec<String>> {
    ensure!(
        output.file_name().is_some()
            && output
                .symlink_metadata()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
        "choose an unused output directory"
    );
    let baseline = inspect_signed_with_policy(previous, verifier, policy)?;
    let delta = read_catalog(changed)?;
    let mut document = baseline.document;
    ensure!(
        delta.sequence > baseline.sequence,
        "module catalog sequence must increase"
    );
    ensure!(
        document["coreApiVersion"] == delta.document["coreApiVersion"],
        "module-only releases require the existing core API version"
    );
    ensure!(
        delta.document.get("legacyUpgrade").is_none()
            || delta.document["legacyUpgrade"] == document["legacyUpgrade"],
        "module-only releases must preserve the first-upgrade roster"
    );
    let updated_at = crate::string(&delta.document, "updatedAt")?;
    verify_packages_with_policy(changed, verifier, &delta.document, policy)?;
    let updates = catalog_plugins(&delta.document)?;
    for (id, next) in updates {
        if let Some(current) = document["plugins"].get(id) {
            let old_version = Version::parse(crate::string(current, "version")?)?;
            let new_version = Version::parse(crate::string(next, "version")?)?;
            ensure!(
                new_version.cmp_precedence(&old_version).is_gt(),
                "{id} must have a newer version than {old_version}"
            );
        }
        document["plugins"][id] = next.clone();
    }
    if let Some(exceptions) = document
        .get_mut("releaseExceptions")
        .and_then(serde_json::Value::as_object_mut)
    {
        for id in updates.keys() {
            exceptions.remove(id);
        }
        if exceptions.is_empty() {
            document
                .as_object_mut()
                .expect("validated catalog object")
                .remove("releaseExceptions");
        }
    }
    document["sequence"] = delta.sequence.into();
    document["updatedAt"] = updated_at.into();

    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let staging = tempfile::Builder::new()
        .prefix(".modules-")
        .tempdir_in(parent)?;
    let mut uploads = Vec::new();
    for (id, plugin) in catalog_plugins(&document)? {
        let version = crate::string(plugin, "version")?;
        let is_update = updates.contains_key(id);
        let source = if is_update { changed } else { previous };
        let assets = plugin["platforms"]
            .as_object()
            .context("invalid platform list")?;
        for platform in assets.keys() {
            let archive = format!("{id}-{version}-{platform}.taomni-plugin");
            for asset in [&archive, &format!("{archive}.minisig")] {
                fs::copy(source.join(asset), staging.path().join(asset))?;
                if is_update {
                    uploads.push(asset.clone());
                }
            }
        }
    }
    fs::write(
        staging.path().join(CATALOG),
        serde_json::to_vec_pretty(&document)?,
    )?;
    inspect_with_policy(staging.path(), verifier, policy)?;
    fs::rename(staging.path(), output)?;
    Ok(uploads)
}

#[cfg(test)]
mod tests;
