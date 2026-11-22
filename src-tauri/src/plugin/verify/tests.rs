use std::fs;
use std::io::{Cursor, Write};

use tempfile::tempdir;
use zip::{ZipWriter, write::SimpleFileOptions};

use super::signature::SignatureVerifier;
use super::test_support::{self as support, archive, files, manifest, package_signature, sign};
use super::*;
use crate::plugin::install::ModuleInstaller;

fn catalog_bytes(sequence: u64, archive: &[u8], signature: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "coreApiVersion":"1", "sequence":sequence, "updatedAt":"2026-11-16T00:00:00Z",
        "plugins":{"taomni-plugin-mfa":{
            "id":"taomni-plugin-mfa", "slug":"mfa", "name":"MFA", "version":"1.0.0",
            "coreApiVersion":"1", "platforms":{(host_platform()):{
                "url":"https://example.com/mfa.taomni-plugin", "signature":signature,
                "sha256":sha256_hex(archive), "size":archive.len()
            }}
        }}
    }))
    .unwrap()
}

fn raw_package(bytes: &[u8], signature: &str) -> Result<VerifiedPackage, TrustError> {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(bytes).unwrap();
    VerifiedPackage::from_offline(file.path(), signature, host_platform())
}

#[test]
fn release_public_key_is_well_formed_and_minisign_matches_upstream_vectors() {
    assert!(SignatureVerifier::release_key().is_ok());
    use base64::{Engine, engine::general_purpose::STANDARD};
    let verifier = SignatureVerifier::test_key(&STANDARD.encode(
        "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n",
    ));
    // Upstream prehashed Minisign vector also verifies the global signature
    // that binds the trusted comment. It covers the streaming package path.
    let signature = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";
    assert!(verifier.verify_bytes(b"test", signature).is_ok());
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(b"test").unwrap();
    assert!(verifier.verify_file(file.as_file_mut(), signature).is_ok());
    assert!(verifier.verify_bytes(b"Test", signature).is_err());
    assert!(
        verifier
            .verify_bytes(b"test", &signature.replace("file:test", "file:evil"))
            .is_err()
    );
}

#[test]
fn rejects_unsigned_bytes_wrong_key_and_tampered_trusted_comments() {
    let verifier = support::verifier();
    let signature = sign(b"payload", "sequence=1");
    assert!(verifier.verify_bytes(b"payload", &signature).is_ok());
    assert!(verifier.verify_bytes(b"changed", &signature).is_err());
    assert!(
        verifier
            .verify_bytes(b"payload", &signature.replace("sequence=1", "sequence=2"))
            .is_err()
    );
    assert!(
        SignatureVerifier::release_key()
            .unwrap()
            .verify_bytes(b"payload", &signature)
            .is_err()
    );
    for invalid in ["", "%%%", "not signed", &(signature.clone() + "extra\n")] {
        assert!(verifier.verify_bytes(b"payload", invalid).is_err());
    }
}

#[test]
fn catalog_watermark_survives_restart_and_rejects_rollback_and_equivocation() {
    let root = tempdir().unwrap();
    let bytes = archive(files(&manifest()));
    let signature = package_signature(&bytes, &manifest(), host_platform());
    let raw = catalog_bytes(42, &bytes, &signature);
    let detached = sign(&raw, "file=modules.json");
    assert!(VerifiedCatalog::verify(&raw, &detached, root.path()).is_ok());
    assert!(VerifiedCatalog::verify(&raw, &detached, root.path()).is_ok());
    let lower = catalog_bytes(41, &bytes, &signature);
    assert!(matches!(
        VerifiedCatalog::verify(&lower, &sign(&lower, "file=modules.json"), root.path()),
        Err(TrustError::Metadata(VerifyError::SequenceRollback { .. }))
    ));
    let changed = String::from_utf8(raw)
        .unwrap()
        .replace("MFA", "Renamed MFA")
        .into_bytes();
    assert!(
        VerifiedCatalog::verify(&changed, &sign(&changed, "file=modules.json"), root.path())
            .is_err()
    );
    let watermark = fs::read_to_string(root.path().join("catalog-sequence.json")).unwrap();
    assert!(watermark.contains("\"sequence\":42"));
}

#[test]
fn unauthenticated_catalog_never_updates_the_watermark() {
    let root = tempdir().unwrap();
    let raw = catalog_bytes(99, b"archive", "signature");
    assert!(
        VerifiedCatalog::verify(&raw, &sign(b"different", "file=modules.json"), root.path())
            .is_err()
    );
    assert!(!root.path().join("catalog-sequence.json").exists());
    fs::write(root.path().join("catalog-sequence.json"), b"{corrupt").unwrap();
    assert!(VerifiedCatalog::verify(&raw, &sign(&raw, "file=modules.json"), root.path()).is_err());
    assert_eq!(
        fs::read(root.path().join("catalog-sequence.json")).unwrap(),
        b"{corrupt"
    );
}

#[test]
fn concurrent_catalog_updates_cannot_lower_a_durable_sequence() {
    let root = tempdir().unwrap();
    let workers = (1..=8)
        .map(|sequence| {
            let path = root.path().to_owned();
            std::thread::spawn(move || {
                let raw = catalog_bytes(sequence, b"archive", "signature");
                let _ = VerifiedCatalog::verify(&raw, &sign(&raw, "file=modules.json"), &path);
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("catalog-sequence.json")).unwrap())
            .unwrap();
    assert_eq!(state["sequence"], 8);
}

#[test]
fn signed_catalog_binds_package_bytes_identity_size_and_platform() {
    let root = tempdir().unwrap();
    let manifest = manifest();
    let bytes = archive(files(&manifest));
    let signature = package_signature(&bytes, &manifest, host_platform());
    let raw = catalog_bytes(1, &bytes, &signature);
    let catalog =
        VerifiedCatalog::verify(&raw, &sign(&raw, "file=modules.json"), root.path()).unwrap();
    let path = root.path().join("mfa.taomni-plugin");
    fs::write(&path, &bytes).unwrap();
    let verified =
        VerifiedPackage::from_catalog(&path, &catalog, &manifest.id, host_platform()).unwrap();
    assert_eq!(verified.manifest(), &manifest);
    assert!(
        VerifiedPackage::from_catalog(&path, &catalog, "taomni-plugin-other", host_platform())
            .is_err()
    );
    assert!(VerifiedPackage::from_catalog(&path, &catalog, &manifest.id, "unsupported").is_err());
    let mut changed = bytes.clone();
    changed[0] ^= 1;
    fs::write(&path, changed).unwrap();
    assert!(VerifiedPackage::from_catalog(&path, &catalog, &manifest.id, host_platform()).is_err());
    assert_eq!(verified.manifest(), &manifest); // already-verified snapshot survives source mutation
}

#[test]
fn signed_comment_must_bind_every_field_and_match_inner_manifest() {
    let manifest = manifest();
    let bytes = archive(files(&manifest));
    let comment = format!(
        "id={} version=1.0.0 platform={} coreApiVersion=1 sha256={}",
        manifest.id,
        host_platform(),
        sha256_hex(&bytes)
    );
    for changed in [
        comment.replace("version=1.0.0", "version=2.0.0"),
        comment.replace("coreApiVersion=1", "coreApiVersion=2"),
        comment.replace(
            &format!("platform={}", host_platform()),
            "platform=unsupported",
        ),
        comment.replace("id=taomni-plugin-mfa", "id=taomni-plugin-vnc"),
        comment.replace(&sha256_hex(&bytes), &"a".repeat(64)),
        format!("{comment} version=1.0.0"),
        comment.replace(" coreApiVersion=1", ""),
    ] {
        assert!(
            raw_package(&bytes, &sign(&bytes, &changed)).is_err(),
            "{changed}"
        );
    }
}

#[test]
fn official_signature_cannot_introduce_a_permission_unknown_to_the_core() {
    let mut manifest = manifest();
    manifest.permissions.insert("vault.read-any-entry".into());
    let bytes = archive(files(&manifest));
    let signature = package_signature(&bytes, &manifest, host_platform());
    let error = raw_package(&bytes, &signature).unwrap_err().to_string();
    assert!(error.contains("permission unknown"), "{error}");
}

#[test]
fn rejects_missing_extra_or_mismatched_inner_checksums() {
    let manifest = manifest();
    let mut contents = files(&manifest);
    contents.insert("SHA256SUMS".into(), b"".to_vec());
    let bytes = archive(contents);
    assert!(
        raw_package(
            &bytes,
            &package_signature(&bytes, &manifest, host_platform())
        )
        .is_err()
    );
    let mut contents = files(&manifest);
    contents.insert(
        "SHA256SUMS".into(),
        format!("{}  module.json\n", "a".repeat(64)).into_bytes(),
    );
    let bytes = archive(contents);
    assert!(
        raw_package(
            &bytes,
            &package_signature(&bytes, &manifest, host_platform())
        )
        .is_err()
    );
}

#[test]
fn rejects_portability_traversal_reserved_names_and_case_collisions() {
    let manifest = manifest();
    for name in [
        "../outside",
        "/absolute",
        "C:/drive",
        "a\\b",
        "a/../b",
        "a//b",
        "NUL.txt",
        "file:stream",
        ".taomni-trust/receipt",
        "trailing. ",
    ] {
        let mut contents = files(&manifest);
        contents.insert(name.into(), b"payload".to_vec());
        let bytes = archive(contents);
        assert!(
            raw_package(
                &bytes,
                &package_signature(&bytes, &manifest, host_platform())
            )
            .is_err(),
            "{name}"
        );
    }
    let mut contents = files(&manifest);
    contents.insert("Host".into(), b"case collision".to_vec());
    let bytes = archive(contents);
    assert!(
        raw_package(
            &bytes,
            &package_signature(&bytes, &manifest, host_platform())
        )
        .is_err()
    );
}

#[test]
fn rejects_signed_zip_symlinks_and_excessive_expansion() {
    let manifest = manifest();
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_symlink("host", "../../outside", SimpleFileOptions::default())
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    assert!(
        raw_package(
            &bytes,
            &package_signature(&bytes, &manifest, host_platform())
        )
        .is_err()
    );
    let mut contents = files(&manifest);
    contents.insert("bomb".into(), vec![0; 2 * 1024 * 1024]);
    // The normal fixture uses Stored; explicitly make a highly compressed ZIP.
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in contents {
        writer
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();
    let error = raw_package(
        &bytes,
        &package_signature(&bytes, &manifest, host_platform()),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("expansion"), "{error}");
}

#[test]
fn stage_retains_authentic_proof_and_rejects_installed_tampering_or_fake_receipt() {
    let root = tempdir().unwrap();
    let manifest = manifest();
    let package = support::verified_package(&manifest);
    let installer = ModuleInstaller::new(root.path());
    let destination = installer.stage_verified(&package).unwrap();
    assert_eq!(
        verify_installed(&destination, host_platform()).unwrap(),
        manifest
    );
    assert_eq!(installer.stage_verified(&package).unwrap(), destination);
    fs::write(destination.join("frontend/index.js"), b"tampered").unwrap();
    assert!(verify_installed(&destination, host_platform()).is_err());
    assert!(installer.stage_verified(&package).is_err());
    assert_eq!(
        installer.active_pointer("mfa").unwrap().active_version,
        None
    );
    let fake = tempdir().unwrap();
    fs::write(
        fake.path().join("module.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(fake.path().join("receipt.json"), b"{\"verified\":true}").unwrap();
    assert!(verify_installed(fake.path(), host_platform()).is_err());
}

#[test]
fn catalog_install_can_be_reused_with_the_original_offline_sidecar() {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let root = tempdir().unwrap();
    let manifest = manifest();
    let bytes = archive(files(&manifest));
    let sidecar = package_signature(&bytes, &manifest, host_platform());
    let raw = catalog_bytes(42, &bytes, sidecar.trim_end());
    let catalog =
        VerifiedCatalog::verify(&raw, &sign(&raw, "file=modules.json"), root.path()).unwrap();
    let path = root.path().join("module.taomni-plugin");
    fs::write(&path, &bytes).unwrap();
    let catalog_package =
        VerifiedPackage::from_catalog(&path, &catalog, &manifest.id, host_platform()).unwrap();
    let installer = ModuleInstaller::new(root.path());
    let installed = installer.stage_verified(&catalog_package).unwrap();
    let proof = installed_proof_paths(&installed).1;

    for previous in [
        sidecar.trim_end().to_owned(),
        sidecar.replace('\n', "\r\n"),
        STANDARD.encode(&sidecar),
    ] {
        fs::write(&proof, previous).unwrap();
        let offline_package = raw_package(&bytes, &sidecar).unwrap();
        assert_eq!(
            installer.stage_verified(&offline_package).unwrap(),
            installed
        );
        assert_eq!(
            verify_installed(&installed, host_platform()).unwrap(),
            manifest
        );
    }
    fs::write(&proof, sidecar.replace("version=1.0.0", "version=1.1.0")).unwrap();
    assert!(installer.stage_verified(&catalog_package).is_err());
    assert!(verify_installed(&installed, host_platform()).is_err());
}

#[test]
fn mutation_of_verified_tree_before_stage_never_publishes_a_version() {
    let root = tempdir().unwrap();
    let package = support::verified_package(&manifest());
    fs::write(
        package.directory().join("host"),
        b"changed after verification",
    )
    .unwrap();
    let installer = ModuleInstaller::new(root.path());
    assert!(installer.stage_verified(&package).is_err());
    assert!(!root.path().join("mfa/versions/1.0.0").exists());
    assert!(
        fs::read_dir(root.path().join("mfa/versions"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn symlinked_proof_and_installed_entries_cannot_bypass_verification() {
    use std::os::unix::fs::symlink;
    let root = tempdir().unwrap();
    let package = support::verified_package(&manifest());
    let installer = ModuleInstaller::new(root.path());
    let destination = installer.stage_verified(&package).unwrap();
    fs::remove_file(destination.join("host")).unwrap();
    symlink(package.directory().join("host"), destination.join("host")).unwrap();
    assert!(verify_installed(&destination, host_platform()).is_err());
}

#[test]
fn failed_upgrade_preserves_the_previous_atomic_pointer() {
    let root = tempdir().unwrap();
    let mut manifest = manifest();
    let installer = ModuleInstaller::new(root.path());
    installer
        .stage_verified(&support::verified_package(&manifest))
        .unwrap();
    installer.activate("mfa", "1.0.0").unwrap();
    manifest.version = "1.1.0".into();
    let candidate = support::verified_package(&manifest);
    fs::write(candidate.directory().join("host"), b"corrupt").unwrap();
    assert!(installer.stage_verified(&candidate).is_err());
    assert_eq!(
        installer
            .active_pointer("mfa")
            .unwrap()
            .active_version
            .as_deref(),
        Some("1.0.0")
    );
    assert!(!root.path().join("mfa/versions/1.1.0").exists());
}

#[test]
fn cached_asset_trust_hashes_the_returned_bytes_and_rejects_changes_or_unknown_files() {
    let root = tempdir().unwrap();
    let package = support::verified_package(&manifest());
    let destination = ModuleInstaller::new(root.path())
        .stage_verified(&package)
        .unwrap();
    let trust = InstalledTrust::verify(&destination, host_platform()).unwrap();
    assert_eq!(trust.manifest(), package.manifest());
    assert_eq!(
        trust.read_file("frontend/index.js").unwrap(),
        b"export default () => null;"
    );
    assert!(trust.read_file("../host").is_err());
    assert!(
        trust
            .read_file(".taomni-trust/package.taomni-plugin")
            .is_err()
    );
    fs::write(destination.join("frontend/unsigned.js"), b"unsigned").unwrap();
    assert!(trust.read_file("frontend/unsigned.js").is_err());
    fs::write(destination.join("frontend/index.js"), b"changed").unwrap();
    assert!(trust.read_file("frontend/index.js").is_err());
}
