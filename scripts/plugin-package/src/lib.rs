//! Build one immutable official plugin ZIP and verify its detached signature.

pub mod qa_catalog;
pub mod qa_first_release;
pub mod release_catalog;
pub mod signing;

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use signing::ReleaseSigner;

const PLATFORMS: [&str; 4] = [
    "linux-x86_64",
    "windows-x86_64",
    "darwin-aarch64",
    "darwin-x86_64",
];

pub fn package(
    payload: &Path,
    platform: &str,
    output: &Path,
    source: &str,
    signer: &ReleaseSigner,
) -> Result<Value> {
    ensure!(PLATFORMS.contains(&platform), "unsupported module platform");
    ensure!(
        source.len() == 40 && source.bytes().all(|c| c.is_ascii_hexdigit()),
        "source-sha must be a full commit SHA"
    );
    ensure!(
        payload.is_dir() && !payload.is_symlink(),
        "payload must be a real directory"
    );
    ensure!(
        !output.is_symlink()
            && (!output.exists() || (output.is_dir() && fs::read_dir(output)?.next().is_none())),
        "output directory must be empty"
    );
    let files = payload_files(payload)?;
    ensure!(
        files.contains_key("module.json"),
        "module.json is absent from payload"
    );
    let manifest: Value = serde_json::from_slice(&fs::read(payload.join("module.json"))?)?;
    let slug = string(&manifest, "slug")?;
    ensure!(valid_slug(slug), "invalid plugin slug");
    let id = string(&manifest, "id")?;
    ensure!(
        id == format!("taomni-plugin-{slug}"),
        "plugin id does not match slug"
    );
    let version = string(&manifest, "version")?;
    semver::Version::parse(version).context("invalid module version")?;
    let api = string(&manifest, "coreApiVersion")?;
    ensure!(
        !api.is_empty() && api.bytes().all(|c| c.is_ascii_digit()),
        "invalid core API version"
    );
    ensure!(
        manifest["platforms"]
            .as_array()
            .is_some_and(|values| values.iter().any(|v| v == platform)),
        "manifest does not declare platform"
    );
    let entries = manifest["entry"]
        .as_object()
        .context("missing plugin entries")?;
    let mut declared = Vec::new();
    for entry in ["host", "frontend"] {
        let name = match entries.get(entry) {
            None | Some(Value::Null) => continue,
            Some(Value::String(name)) => name,
            Some(_) => anyhow::bail!("plugin {entry} entry must be a path string"),
        };
        ensure!(
            files.contains_key(name),
            "plugin entry is absent from payload: {name}"
        );
        declared.push(name);
    }
    ensure!(!declared.is_empty(), "module must declare an entry");
    let host = manifest["entry"]["host"].as_str();
    ensure!(
        !platform.starts_with("windows") || host.is_none_or(|host| host.ends_with(".exe")),
        "Windows host entry must name its .exe"
    );
    let sums = files
        .iter()
        .map(|(name, digest)| format!("{digest}  {name}\n"))
        .collect::<String>();
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let staged = tempfile::tempdir_in(parent)?;
    let name = format!("{id}-{version}-{platform}.taomni-plugin");
    let archive = staged.path().join(&name);
    let mut zip = ZipWriter::new(File::create(&archive)?);
    for (name, expected_hash) in &files {
        let mode = if Some(name.as_str()) == host {
            0o755
        } else {
            0o644
        };
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(mode);
        zip.start_file(name, options)?;
        let mut input = File::open(payload.join(name))?;
        let mut copied = Sha256::new();
        let mut bytes = [0_u8; 128 * 1024];
        loop {
            let size = input.read(&mut bytes)?;
            if size == 0 {
                break;
            }
            copied.update(&bytes[..size]);
            zip.write_all(&bytes[..size])?;
        }
        ensure!(
            format!("{:x}", copied.finalize()) == *expected_hash,
            "payload changed while packaging: {name}"
        );
    }
    zip.start_file(
        "SHA256SUMS",
        SimpleFileOptions::default().unix_permissions(0o644),
    )?;
    zip.write_all(sums.as_bytes())?;
    zip.finish()?.sync_all()?;
    let digest = sha256(&archive)?;
    let comment = format!(
        "id={id} version={version} platform={platform} coreApiVersion={api} sha256={digest}"
    );
    let signature = signer.sign(&archive, &comment)?;
    let receipt = json!({
        "schema": "taomni.plugin-package.v1", "sourceSha": source.to_lowercase(),
        "id": id, "slug": slug, "version": version, "platform": platform,
        "coreApiVersion": api, "archive": name, "sha256": digest,
        "size": fs::metadata(&archive)?.len(), "signature": format!("{name}.minisig"),
        "trust": "plugins.updater.pubkey", "systemTrust": "unverified",
    });
    fs::write(staged.path().join(format!("{name}.minisig")), signature)?;
    fs::write(
        staged.path().join("module.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::write(
        staged.path().join("provenance.json"),
        serde_json::to_vec_pretty(&receipt)?,
    )?;
    fs::write(
        staged.path().join("SHA256SUMS"),
        format!("{digest}  {name}\n"),
    )?;
    // Only public artifacts leave the temporary directory. No key file is ever
    // created, and a signing/validation failure publishes no completed package.
    if output.exists() {
        // remove_dir succeeds only for the already-required empty directory.
        // A concurrently added file aborts publication without deleting it.
        fs::remove_dir(output)?;
    }
    fs::rename(staged.path(), output)?;
    Ok(receipt)
}

fn string<'a>(manifest: &'a Value, key: &str) -> Result<&'a str> {
    manifest[key]
        .as_str()
        .with_context(|| format!("missing module {key}"))
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 128
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && slug
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn register_payload_path(path: &Path, folded: &mut BTreeSet<String>) -> Result<String> {
    ensure!(
        path.components()
            .all(|part| matches!(part, Component::Normal(_))),
        "unsafe payload path"
    );
    let name = path
        .to_str()
        .context("payload paths must be UTF-8")?
        .replace(std::path::MAIN_SEPARATOR, "/");
    ensure!(
        name.len() <= 1024 && name.split('/').count() <= 32,
        "payload path exceeds portable bounds"
    );
    ensure!(
        !name.contains(['\\', ':', '\r', '\n', '\0']),
        "unsafe payload path"
    );
    ensure!(
        !name
            .split('/')
            .any(|part| part.ends_with(['.', ' ']) || part.starts_with('.')),
        "reserved payload path"
    );
    for part in name.split('/') {
        let base = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        ensure!(
            !matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(base.len() == 4
                    && (base.starts_with("COM") || base.starts_with("LPT"))
                    && matches!(base.as_bytes()[3], b'1'..=b'9')),
            "reserved Windows payload path"
        );
    }
    ensure!(
        !name.eq_ignore_ascii_case("SHA256SUMS"),
        "SHA256SUMS is generated by the packager"
    );
    ensure!(
        folded.insert(name.to_lowercase()),
        "case-insensitive payload path collision"
    );
    Ok(name)
}

fn payload_files(root: &Path) -> Result<BTreeMap<String, String>> {
    fn visit(
        root: &Path,
        at: &Path,
        result: &mut BTreeMap<String, String>,
        folded: &mut BTreeSet<String>,
    ) -> Result<()> {
        for entry in fs::read_dir(at)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            ensure!(!kind.is_symlink(), "payload symlinks are not supported");
            let name = register_payload_path(entry.path().strip_prefix(root)?, folded)?;
            if kind.is_dir() {
                visit(root, &entry.path(), result, folded)?;
            } else {
                ensure!(kind.is_file(), "payload must contain only ordinary files");
                result.insert(name, sha256(&entry.path())?);
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    visit(root, root, &mut files, &mut BTreeSet::new())?;
    Ok(files)
}

fn sha256(path: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    let mut file = File::open(path)?;
    let mut bytes = [0_u8; 128 * 1024];
    loop {
        let size = file.read(&mut bytes)?;
        if size == 0 {
            break;
        }
        hash.update(&bytes[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests;
