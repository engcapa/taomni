use super::*;
use crate::plugin::verify::{
    sha256_hex,
    test_support::{manifest, sign},
};
use std::{
    fs,
    io::{Cursor, Write},
};
use tempfile::tempdir;
use zip::{ZipWriter, write::SimpleFileOptions};

fn fixture(root: &Path) -> (CatalogSelection, Vec<u8>) {
    let manifest = manifest();
    let files = std::collections::BTreeMap::from([
        ("module.json", serde_json::to_vec(&manifest).unwrap()),
        ("host", b"signed host fixture".to_vec()),
        ("frontend/index.js", b"export default () => null;".to_vec()),
    ]);
    let sums = files
        .iter()
        .map(|(name, bytes)| format!("{}  {name}\n", sha256_hex(bytes)))
        .collect::<String>();
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in &files {
        archive
            .start_file(*name, SimpleFileOptions::default().unix_permissions(0o755))
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    archive
        .start_file("SHA256SUMS", SimpleFileOptions::default())
        .unwrap();
    archive.write_all(sums.as_bytes()).unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let digest = sha256_hex(&bytes);
    let package_signature = sign(
        &bytes,
        &format!(
            "id={} version={} platform={} coreApiVersion=1 sha256={digest}",
            manifest.id,
            manifest.version,
            current_platform()
        ),
    );
    let catalog = serde_json::json!({
        "coreApiVersion":"1", "sequence":42, "updatedAt":"2026-11-16T00:00:00Z",
        "plugins":{(&manifest.id): {
            "id":manifest.id,"slug":manifest.slug,"name":manifest.name,"version":manifest.version,"coreApiVersion":"1",
            "platforms":{(current_platform()):{
                "url":"https://example.test/official.taomni-plugin","size":bytes.len(),"sha256":digest,"signature":package_signature
            }}
        }}
    });
    let payload = serde_json::to_string(&catalog).unwrap();
    let signature = sign(payload.as_bytes(), "file=modules.json");
    let cache = root.join(".catalog-trust");
    fs::create_dir_all(&cache).unwrap();
    fs::write(
        cache.join("catalog.json"),
        serde_json::to_vec(&serde_json::json!({"payload":payload,"signature":signature})).unwrap(),
    )
    .unwrap();
    (
        CatalogSelection {
            plugin_id: manifest.id,
            version: manifest.version,
            sha256: digest,
        },
        bytes,
    )
}

#[test]
fn plans_only_signed_native_asset_and_stable_content_paths() {
    let root = tempdir().unwrap();
    let (selection, bytes) = fixture(root.path());
    let first = download_plan(root.path(), &selection, None).unwrap();
    let second = download_plan(root.path(), &selection, None).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.partial_path, second.partial_path);
    assert_eq!(first.url, "https://example.test/official.taomni-plugin");
    assert_eq!(first.expected_total, Some(bytes.len() as u64));
    assert_eq!(
        first.expected_sha256.as_deref(),
        Some(selection.sha256.as_str())
    );
    assert_eq!(
        first.completed_path.parent(),
        Some(root.path().join(".downloads").as_path())
    );
    assert_ne!(first.partial_path, first.completed_path);
}

#[test]
fn stale_version_hash_and_absent_identity_cannot_select_other_bytes() {
    let root = tempdir().unwrap();
    let (selection, _) = fixture(root.path());
    for altered in [
        CatalogSelection {
            version: "9.0.0".into(),
            ..selection.clone()
        },
        CatalogSelection {
            sha256: "b".repeat(64),
            ..selection.clone()
        },
        CatalogSelection {
            plugin_id: "../../untrusted".into(),
            ..selection.clone()
        },
    ] {
        assert!(download_plan(root.path(), &altered, None).is_err());
    }
    assert!(!root.path().join(".downloads").exists());
}

#[test]
fn renderer_cannot_supply_platform_url_path_or_trust_flags() {
    let value = serde_json::json!({"pluginId":"taomni-plugin-mfa","version":"1.0.0","sha256":"a".repeat(64)});
    for field in ["url", "platform", "completedPath", "signature", "verified"] {
        let mut changed = value.clone();
        changed[field] = serde_json::json!("untrusted");
        assert!(serde_json::from_value::<CatalogSelection>(changed).is_err());
    }
}

#[test]
fn review_requires_completed_signed_archive_and_tampering_is_rechecked() {
    let root = tempdir().unwrap();
    let (selection, bytes) = fixture(root.path());
    let plan = download_plan(root.path(), &selection, None).unwrap();
    assert!(prepare_install(root.path(), &selection).is_err());
    fs::create_dir_all(plan.partial_path.parent().unwrap()).unwrap();
    fs::write(&plan.partial_path, &bytes).unwrap();
    assert!(prepare_install(root.path(), &selection).is_err());
    fs::rename(&plan.partial_path, &plan.completed_path).unwrap();
    let (package, review) = prepare_install(root.path(), &selection).unwrap();
    assert_eq!(review.manifest, *package.manifest());
    assert_eq!(review.manifest, manifest());
    assert_eq!(review.download_id, plan.id);
    assert_eq!(
        Path::new(&review.data_directory),
        root.path().join("mfa/data")
    );
    let mut tampered = bytes;
    tampered[0] ^= 1;
    fs::write(plan.completed_path, tampered).unwrap();
    assert!(prepare_install(root.path(), &selection).is_err());
    assert!(!root.path().join("mfa/active.json").exists());
}

#[test]
fn native_platform_is_required_and_unsigned_or_missing_cache_fails_closed() {
    let root = tempdir().unwrap();
    let (selection, _) = fixture(root.path());
    let catalog = read_cached_catalog(root.path()).unwrap();
    assert!(plan_from_catalog(root.path(), &selection, &catalog, "unsupported").is_err());
    let cache = root.path().join(".catalog-trust/catalog.json");
    let mut envelope: serde_json::Value =
        serde_json::from_slice(&fs::read(&cache).unwrap()).unwrap();
    envelope["payload"] = serde_json::json!(
        envelope["payload"]
            .as_str()
            .unwrap()
            .replace("MFA", "Changed")
    );
    fs::write(&cache, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert!(download_plan(root.path(), &selection, None).is_err());
    fs::remove_file(cache).unwrap();
    assert!(download_plan(root.path(), &selection, None).is_err());
}

#[test]
fn catalog_permissions_and_category_must_match_the_actual_signed_package() {
    for (field, value) in [
        ("permissions", serde_json::json!(["capture.screen"])),
        ("kind", serde_json::json!("media")),
        (
            "document",
            serde_json::json!({"fileKinds":["audio"], "extensions":["wav"]}),
        ),
    ] {
        let root = tempdir().unwrap();
        let (selection, bytes) = fixture(root.path());
        let path = root.path().join(".catalog-trust/catalog.json");
        let mut envelope: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut catalog: serde_json::Value =
            serde_json::from_str(envelope["payload"].as_str().unwrap()).unwrap();
        catalog["plugins"][&selection.plugin_id][field] = value;
        let payload = serde_json::to_string(&catalog).unwrap();
        envelope["signature"] = serde_json::json!(sign(payload.as_bytes(), "file=modules.json"));
        envelope["payload"] = serde_json::json!(payload);
        fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
        let plan = download_plan(root.path(), &selection, None).unwrap();
        fs::create_dir_all(plan.completed_path.parent().unwrap()).unwrap();
        fs::write(plan.completed_path, bytes).unwrap();
        assert!(
            prepare_install(root.path(), &selection)
                .unwrap_err()
                .to_string()
                .contains("permissions or category")
        );
        assert!(!root.path().join("mfa/active.json").exists());
    }
}
