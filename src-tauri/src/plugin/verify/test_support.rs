//! Real Ed25519-signed package fixtures; no unsigned trust constructor exists.

use std::collections::BTreeMap;
use std::io::{Cursor, Write};

use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use zip::{ZipWriter, write::SimpleFileOptions};

use super::signature::SignatureVerifier;
use super::{VerifiedPackage, sha256_hex};
use crate::plugin::ModuleManifest;

pub(super) fn verifier() -> SignatureVerifier {
    let signing = SigningKey::from_bytes(&[91; 32]);
    let mut raw = b"Ed".to_vec();
    raw.extend_from_slice(&[7; 8]);
    raw.extend_from_slice(signing.verifying_key().as_bytes());
    let public = format!("untrusted comment: test key\n{}\n", STANDARD.encode(raw));
    SignatureVerifier::test_key(&STANDARD.encode(public))
}

pub(crate) fn sign(bytes: &[u8], comment: &str) -> String {
    let signing = SigningKey::from_bytes(&[91; 32]);
    let signature = signing.sign(bytes).to_bytes();
    let mut packet = b"Ed".to_vec();
    packet.extend_from_slice(&[7; 8]);
    packet.extend_from_slice(&signature);
    let mut global = signature.to_vec();
    global.extend_from_slice(comment.as_bytes());
    format!(
        "untrusted comment: unit fixture\n{}\ntrusted comment: {comment}\n{}\n",
        STANDARD.encode(packet),
        STANDARD.encode(signing.sign(&global).to_bytes()),
    )
}

pub(crate) fn manifest() -> ModuleManifest {
    serde_json::from_value(serde_json::json!({
        "id":"taomni-plugin-mfa", "slug":"mfa", "name":"MFA", "version":"1.0.0",
        "coreApiVersion":"1", "kind":"auth", "status":"stable", "removalCandidate":false,
        "platforms":["linux-x86_64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"],
        "entry":{"host":"host", "frontend":"frontend/index.js", "protocol":1},
        "tabs":[], "commands":["ping"], "permissions":[], "dataDir":"plugins/mfa",
        "backupPaths":["plugins/mfa/data/data.db"], "legacyTables":[], "vaultFixedKeys":[], "snapshot":"file"
    }))
    .unwrap()
}

pub(super) fn files(manifest: &ModuleManifest) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::from([("module.json".into(), serde_json::to_vec(manifest).unwrap())]);
    if let Some(host) = &manifest.entry.host {
        files.insert(host.clone(), b"signed host bytes".to_vec());
    }
    if let Some(frontend) = &manifest.entry.frontend {
        files.insert(frontend.clone(), b"export default () => null;".to_vec());
    }
    files
}

pub(super) fn archive(mut files: BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let sums = files
        .iter()
        .map(|(path, bytes)| format!("{}  {path}\n", sha256_hex(bytes)))
        .collect::<String>();
    files
        .entry("SHA256SUMS".into())
        .or_insert_with(|| sums.into_bytes());
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (path, bytes) in files {
        writer
            .start_file(path, SimpleFileOptions::default().unix_permissions(0o755))
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

pub(super) fn package_signature(bytes: &[u8], manifest: &ModuleManifest, platform: &str) -> String {
    sign(
        bytes,
        &format!(
            "id={} version={} platform={platform} coreApiVersion={} sha256={}",
            manifest.id,
            manifest.version,
            manifest.core_api_version,
            sha256_hex(bytes),
        ),
    )
}

/// Registry tests can exercise the production staging capability with a real
/// test signature. The verification key override is compiled only for tests.
pub(crate) fn verified_package(manifest: &ModuleManifest) -> VerifiedPackage {
    try_verified_package(manifest).unwrap()
}

#[allow(dead_code)]
pub(crate) fn verified_package_with_files(
    manifest: &ModuleManifest,
    extra: &[(&str, &[u8])],
) -> VerifiedPackage {
    let mut tree = files(manifest);
    for (path, bytes) in extra {
        tree.insert((*path).to_owned(), (*bytes).to_vec());
    }
    let bytes = archive(tree);
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(&bytes).unwrap();
    VerifiedPackage::prepare(
        file.path(),
        &package_signature(&bytes, manifest, super::host_platform()),
        super::host_platform(),
        &verifier(),
        None,
    )
    .unwrap()
}

pub(crate) fn try_verified_package(
    manifest: &ModuleManifest,
) -> Result<VerifiedPackage, super::TrustError> {
    let bytes = archive(files(manifest));
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(&bytes).unwrap();
    VerifiedPackage::prepare(
        file.path(),
        &package_signature(&bytes, manifest, super::host_platform()),
        super::host_platform(),
        &verifier(),
        None,
    )
}
