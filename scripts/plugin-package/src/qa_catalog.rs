//! Fixed loopback catalog for hosted UI verification with the pinned key.
//! It contains only the package just built by the trusted official signer.
use std::{fs, path::Path};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

use crate::signing::ReleaseSigner;

pub const ORIGIN: &str = "http://127.0.0.1:50301";

pub fn write(output: &Path, receipt: &Value, signer: &ReleaseSigner) -> Result<()> {
    let manifest: Value = serde_json::from_slice(&fs::read(output.join("module.json"))?)?;
    let id = receipt["id"].as_str().context("missing package id")?;
    let platform = receipt["platform"]
        .as_str()
        .context("missing package platform")?;
    let archive = receipt["archive"]
        .as_str()
        .context("missing package filename")?;
    ensure!(
        id == "taomni-plugin-hello-plugin" || id == "taomni-plugin-mfa",
        "QA catalog is restricted to official test modules"
    );
    ensure!(
        Path::new(archive)
            .file_name()
            .is_some_and(|name| name == archive),
        "invalid package filename"
    );
    let signature = fs::read_to_string(output.join(format!("{archive}.minisig")))?;
    let plugin = json!({
        "id":id, "slug":receipt["slug"], "name":manifest["name"],
        "version":receipt["version"], "coreApiVersion":receipt["coreApiVersion"],
        "kind":manifest["kind"], "permissions":manifest["permissions"],
        "description":manifest["description"].as_str().unwrap_or("Exercise the official module lifecycle."),
        "platforms":{(platform):{"url":format!("{ORIGIN}/{archive}"), "signature":signature,
            "sha256":receipt["sha256"],"size":receipt["size"]}}
    });
    // Both authenticated sequences are retained to exercise the durable
    // rollback rejection after a successful higher-sequence check/restart.
    for (name, sequence) in [("modules.json", 42), ("modules-older.json", 41)] {
        let raw = serde_json::to_vec_pretty(&json!({
            "coreApiVersion":receipt["coreApiVersion"], "sequence":sequence,
            "updatedAt":"2026-11-16T00:00:00Z", "legacyUpgrade":[id], "plugins":{(id):plugin}
        }))?;
        let path = output.join(name);
        fs::write(&path, raw)?;
        fs::write(
            output.join(format!("{name}.minisig")),
            signer.sign(
                &path,
                &format!(
                    "file={name} sourceSha={}",
                    receipt["sourceSha"].as_str().unwrap()
                ),
            )?,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_exact_official_loopback_metadata_and_both_catalog_sequences() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let signer = ReleaseSigner::test_key();
        let receipt = json!({"id":"taomni-plugin-hello-plugin", "slug":"hello-plugin", "version":"0.1.0", "coreApiVersion":"1",
            "platform":"linux-x86_64", "archive":"hello.taomni-plugin", "sha256":"a".repeat(64), "size":12,"sourceSha":"b".repeat(40)});
        fs::write(
            root.join("module.json"),
            serde_json::to_vec(
                &json!({"name":"Hello Plugin","kind":"collaboration","permissions":["fs.dataDir"]}),
            )
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("hello.taomni-plugin.minisig"),
            "exact package signature\n",
        )
        .unwrap();
        write(root, &receipt, &signer).unwrap();
        for (name, sequence) in [("modules.json", 42), ("modules-older.json", 41)] {
            let path = root.join(name);
            let catalog: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(catalog["sequence"], sequence);
            let plugin = &catalog["plugins"]["taomni-plugin-hello-plugin"];
            assert_eq!(plugin["permissions"], json!(["fs.dataDir"]));
            assert_eq!(
                plugin["platforms"]["linux-x86_64"]["url"],
                format!("{ORIGIN}/hello.taomni-plugin")
            );
            assert_eq!(
                plugin["platforms"]["linux-x86_64"]["signature"],
                "exact package signature\n"
            );
            let signature = fs::read_to_string(root.join(format!("{name}.minisig"))).unwrap();
            let comment = format!("file={name} sourceSha={}", "b".repeat(40));
            signer.verify(&path, &signature, &comment).unwrap();
            fs::write(&path, b"unsigned replacement").unwrap();
            assert!(signer.verify(&path, &signature, &comment).is_err());
        }
        let mut forbidden = receipt;
        forbidden["id"] = json!("taomni-plugin-third-party");
        assert!(write(root, &forbidden, &signer).is_err());
    }
}
