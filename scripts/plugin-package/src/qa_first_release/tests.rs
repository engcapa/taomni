use super::*;
use crate::package;

#[test]
fn requires_every_declared_signed_package_from_the_same_build() {
    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("plugins");
    let artifacts = root.path().join("artifacts");
    let output = root.path().join("first-release");
    let source = "a".repeat(40);
    let build = Build {
        sha: &source,
        run: "42",
        date: "2026-11-22T00:00:00Z",
    };
    let signer = ReleaseSigner::test_key();
    let roster = [
        "taomni-plugin-mail".to_owned(),
        "taomni-plugin-mfa".to_owned(),
    ];

    for slug in ["mail", "mfa"] {
        let dir = sources.join(slug);
        fs::create_dir_all(&dir).unwrap();
        let module = json!({
            "id": format!("taomni-plugin-{slug}"), "slug": slug, "name": slug,
            "description": "Module for the upgrade test", "version": "1.0.0", "coreApiVersion": "1",
            "kind": "auth", "status": "provisional", "entry": {"host":"host"}, "permissions": [],
            "platforms": ["linux-x86_64", "windows-x86_64"]
        });
        fs::write(dir.join("module.json"), module.to_string()).unwrap();
        for platform in ["linux-x86_64", "windows-x86_64"] {
            let payload = root.path().join(format!("payload-{slug}-{platform}"));
            let mut embedded = module.clone();
            if platform.starts_with("windows") {
                embedded["entry"]["host"] = "host.exe".into();
            }
            fs::create_dir(&payload).unwrap();
            fs::write(payload.join("module.json"), embedded.to_string()).unwrap();
            fs::write(
                payload.join(embedded["entry"]["host"].as_str().unwrap()),
                slug,
            )
            .unwrap();
            let target = artifacts
                .join(format!("module-signed-{slug}-{platform}-42"))
                .join("signed-module");
            package(&payload, platform, &target, &source, &signer).unwrap();
        }
    }
    let produce = || assemble(&roster, &sources, &artifacts, &output, &build, &signer);
    produce().unwrap();
    let catalog: Value =
        serde_json::from_reader(File::open(output.join(CATALOG)).unwrap()).unwrap();
    assert_eq!(catalog["legacyUpgrade"], json!(roster));
    assert_eq!(catalog["plugins"].as_object().unwrap().len(), 2);
    let entry = &catalog["plugins"]["taomni-plugin-mail"]["platforms"]["windows-x86_64"];
    assert_eq!(
        entry["url"],
        format!(
            "{}/taomni-plugin-mail-1.0.0-windows-x86_64.taomni-plugin",
            qa_catalog::ORIGIN
        )
    );
    let signature = fs::read_to_string(output.join(format!("{CATALOG}.minisig"))).unwrap();
    signer
        .verify(
            &output.join(CATALOG),
            &signature,
            &format!("file={CATALOG} sourceSha={source}"),
        )
        .unwrap();
    let evidence: Value =
        serde_json::from_reader(File::open(output.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(evidence["packages"].as_array().unwrap().len(), 4);
    fs::remove_dir_all(&output).unwrap();

    let target = artifacts.join("module-signed-mail-windows-x86_64-42/signed-module");
    let receipt = target.join("provenance.json");
    let bytes = fs::read(&receipt).unwrap();
    let mut changed: Value = serde_json::from_slice(&bytes).unwrap();
    changed["sourceSha"] = "b".repeat(40).into();
    fs::write(&receipt, changed.to_string()).unwrap();
    assert!(produce().is_err() && !output.exists());
    fs::write(&receipt, bytes).unwrap();
    let signature = target.join(changed["signature"].as_str().unwrap());
    let original = fs::read(&signature).unwrap();
    fs::write(&signature, "invalid signature").unwrap();
    assert!(produce().is_err() && !output.exists());
    fs::write(signature, original).unwrap();
    fs::remove_dir_all(&target).unwrap();
    assert!(produce().is_err() && !output.exists());
}
