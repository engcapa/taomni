use serde_json::Value;

use super::*;
use crate::release_catalog::{SIGNATURE, tests::stage_module};
use crate::signing::ReleaseSigner;

fn sign(directory: &Path, signer: &ReleaseSigner) {
    let catalog = inspect(directory, signer.test_verifier()).unwrap();
    let signature = signer.sign(&catalog.path, &catalog.comment()).unwrap();
    fs::write(directory.join(SIGNATURE), signature).unwrap();
}

fn delta(
    root: &Path,
    signer: &ReleaseSigner,
    slug: &str,
    version: &str,
) -> (std::path::PathBuf, Value) {
    let (path, mut doc) = stage_module(&root.join(slug), signer, slug, version, "v0.6.1");
    doc["sequence"] = 22.into();
    doc["updatedAt"] = "2026-11-20T00:00:00Z".into();
    doc.as_object_mut().unwrap().remove("legacyUpgrade");
    fs::write(path.join(CATALOG), serde_json::to_vec(&doc).unwrap()).unwrap();
    (path, doc)
}

#[test]
fn adds_a_new_module_and_keeps_the_verified_prior_assets_and_roster() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    let signer = ReleaseSigner::test_key();
    let (baseline, mut original) = stage_module(root, &signer, "mfa", "1.1.0", "v0.6.0");
    original["releaseExceptions"] = serde_json::json!({
        "taomni-plugin-mobile": {
            "placement": "core", "name": "Mobile", "notes": "Mobile remains in the core application."
        }
    });
    fs::write(
        baseline.join(CATALOG),
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();
    sign(&baseline, &signer);
    let (new_assets, incoming) = delta(root, &signer, "vnc-client", "1.0.0");
    let output = root.join("next");
    let new_name = "taomni-plugin-vnc-client-1.0.0-linux-x86_64.taomni-plugin";
    assert_eq!(
        prepare(&baseline, &new_assets, &output, signer.test_verifier()).unwrap(),
        [new_name.to_owned(), format!("{new_name}.minisig")]
    );
    sign(&output, &signer);
    let next = inspect_signed(&output, signer.test_verifier())
        .unwrap()
        .document;
    assert_eq!(next["sequence"], 22);
    assert_eq!(next["legacyUpgrade"], original["legacyUpgrade"]);
    assert_eq!(next["updatedAt"], incoming["updatedAt"]);
    assert_eq!(next["releaseExceptions"], original["releaseExceptions"]);
    assert_eq!(
        next["plugins"]["taomni-plugin-mfa"],
        original["plugins"]["taomni-plugin-mfa"]
    );
    assert_eq!(
        next["plugins"]["taomni-plugin-vnc-client"],
        incoming["plugins"]["taomni-plugin-vnc-client"]
    );
    let (mobile, _) = delta(root, &signer, "mobile", "1.0.0");
    let promoted = root.join("with-mobile");
    prepare(&baseline, &mobile, &promoted, signer.test_verifier()).unwrap();
    let catalog = inspect(&promoted, signer.test_verifier()).unwrap();
    assert!(catalog.document.get("releaseExceptions").is_none());
    assert_eq!(catalog.document["legacyUpgrade"], original["legacyUpgrade"]);
}

#[test]
fn updates_a_first_release_module_without_reissuing_the_earlier_package() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    let signer = ReleaseSigner::test_key();
    let (baseline, original) = stage_module(root, &signer, "mfa", "1.1.0", "v0.6.0");
    sign(&baseline, &signer);
    let (new_assets, incoming) = delta(root, &signer, "mfa", "1.2.0");
    let output = root.join("next");
    let uploads = prepare(&baseline, &new_assets, &output, signer.test_verifier()).unwrap();
    let next = inspect(&output, signer.test_verifier()).unwrap().document;
    assert_eq!(next["legacyUpgrade"], original["legacyUpgrade"]);
    assert_eq!(next["plugins"], incoming["plugins"]);
    assert_eq!(
        uploads.first().unwrap(),
        "taomni-plugin-mfa-1.2.0-linux-x86_64.taomni-plugin"
    );
    assert!(
        !output
            .join("taomni-plugin-mfa-1.1.0-linux-x86_64.taomni-plugin")
            .exists()
    );
}

#[test]
fn rejects_untrusted_baseline_and_invalid_updates_before_creating_output() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    let signer = ReleaseSigner::test_key();
    let (baseline, original) = stage_module(root, &signer, "mfa", "1.1.0", "v0.6.0");
    sign(&baseline, &signer);
    let (new_assets, incoming) = delta(root, &signer, "mfa", "1.1.0");
    let output = root.join("next");
    for (field, value, expected) in [
        ("sequence", 21.into(), "sequence must increase"),
        (
            "legacyUpgrade",
            serde_json::json!([]),
            "preserve the first-upgrade roster",
        ),
        ("coreApiVersion", "2".into(), "existing core API"),
        ("sequence", 22.into(), "must have a newer version"),
    ] {
        let mut invalid = incoming.clone();
        invalid[field] = value;
        fs::write(
            new_assets.join(CATALOG),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        let error = prepare(&baseline, &new_assets, &output, signer.test_verifier()).unwrap_err();
        assert!(error.to_string().contains(expected), "{error}");
        assert!(!output.exists());
    }
    let mut invalid = original;
    invalid["updatedAt"] = "tampered".into();
    fs::write(
        baseline.join(CATALOG),
        serde_json::to_vec(&invalid).unwrap(),
    )
    .unwrap();
    let error = prepare(&baseline, &new_assets, &output, signer.test_verifier()).unwrap_err();
    assert!(error.to_string().contains("signature"), "{error}");
    assert!(!output.exists());
}
