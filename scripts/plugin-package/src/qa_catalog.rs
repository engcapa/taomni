//! Fixed loopback catalog for hosted UI verification with the pinned key.
//! It contains only the package just built by the trusted official signer.
use std::{fs, path::Path};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

use crate::signing::ReleaseSigner;

pub const ORIGIN: &str = "http://127.0.0.1:50301";

pub fn write_legacy_roster(
    hello: &Path,
    mfa: &Path,
    source: &str,
    platform: &str,
    signer: &ReleaseSigner,
) -> Result<()> {
    let mut plugins = serde_json::Map::new();
    for (directory, id) in [
        (hello, "taomni-plugin-hello-plugin"),
        (mfa, "taomni-plugin-mfa"),
    ] {
        let catalog_path = directory.join("modules.json");
        let signature = fs::read_to_string(directory.join("modules.json.minisig"))?;
        let raw = fs::read(&catalog_path)?;
        signer.verify_bytes(
            &raw,
            &signature,
            &format!("file=modules.json sourceSha={source}"),
        )?;
        let catalog: Value = serde_json::from_slice(&raw)?;
        let entry = &catalog["plugins"][id];
        ensure!(
            catalog["plugins"]
                .as_object()
                .is_some_and(|entries| entries.len() == 1)
                && entry["id"] == id
                && entry["platforms"]
                    .as_object()
                    .is_some_and(|targets| targets.len() == 1 && targets.contains_key(platform)),
            "legacy QA roster requires the two matching official module packages"
        );
        plugins.insert(id.to_owned(), entry.clone());
    }
    let roster: Vec<_> = plugins.keys().cloned().collect();
    let mut catalog = json!({
        "coreApiVersion": "1", "sequence": 42, "updatedAt": "2026-11-16T00:00:00Z",
        "legacyUpgrade": roster, "plugins": plugins
    });
    sign_catalog(hello, "modules-roster.json", &catalog, source, signer)?;
    catalog["sequence"] = json!(44);
    catalog["legacyUpgrade"] = json!(["taomni-plugin-mfa"]);
    sign_catalog(
        hello,
        "modules-roster-with-optional.json",
        &catalog,
        source,
        signer,
    )
}

const QA_CATALOG_PLUGIN_IDS: [&str; 11] = [
    "taomni-plugin-hello-plugin",
    "taomni-plugin-ai-voice-local",
    "taomni-plugin-mail",
    "taomni-plugin-mfa",
    "taomni-plugin-rdp-client",
    "taomni-plugin-rdp-server",
    "taomni-plugin-screenshot",
    "taomni-plugin-servers",
    "taomni-plugin-sockscap",
    "taomni-plugin-vnc-client",
    "taomni-plugin-vnc-server",
];

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
        QA_CATALOG_PLUGIN_IDS.contains(&id),
        "QA catalog is restricted to official modules"
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
    let source = receipt["sourceSha"]
        .as_str()
        .context("missing package source SHA")?;
    let installed_roster = json!([id]);
    let plugin_entry = json!({(id): plugin});
    let empty_roster = json!([]);
    let empty_catalog = json!({});
    // Preserve the legacy enrollment and rollback inputs. The second pair
    // introduces Hello as an optional module outside the fixed legacy roster.
    for (name, sequence, roster, plugins) in [
        ("modules.json", 42, &installed_roster, &plugin_entry),
        ("modules-older.json", 41, &installed_roster, &plugin_entry),
        ("modules-baseline.json", 43, &empty_roster, &empty_catalog),
        ("modules-new.json", 44, &empty_roster, &plugin_entry),
    ] {
        let catalog = json!({
            "coreApiVersion":receipt["coreApiVersion"], "sequence":sequence,
            "updatedAt":"2026-11-16T00:00:00Z", "legacyUpgrade":roster, "plugins":plugins
        });
        sign_catalog(output, name, &catalog, source, signer)?;
    }
    Ok(())
}

pub(super) fn sign_catalog(
    output: &Path,
    name: &str,
    catalog: &Value,
    source: &str,
    signer: &ReleaseSigner,
) -> Result<()> {
    let path = output.join(name);
    fs::write(&path, serde_json::to_vec_pretty(catalog)?)?;
    fs::write(
        output.join(format!("{name}.minisig")),
        signer.sign(&path, &format!("file={name} sourceSha={source}"))?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_upgrade_roster_binds_both_modules_to_one_source_and_platform() {
        let directory = tempfile::tempdir().unwrap();
        let signer = ReleaseSigner::test_key();
        let source = "b".repeat(40);
        let platform = "linux-x86_64";
        let hello = directory.path().join("hello");
        let mfa = directory.path().join("mfa");
        for (root, slug) in [(&hello, "hello-plugin"), (&mfa, "mfa")] {
            fs::create_dir(root).unwrap();
            let id = format!("taomni-plugin-{slug}");
            let archive = format!("{slug}.taomni-plugin");
            let receipt = json!({
                "id": id, "slug": slug, "version": "0.1.0", "coreApiVersion": "1",
                "platform": platform, "archive": archive, "sha256": "a".repeat(64),
                "size": 12, "sourceSha": source,
            });
            fs::write(root.join("module.json"), json!({"name": slug}).to_string()).unwrap();
            fs::write(root.join(format!("{archive}.minisig")), "package signature").unwrap();
            write(root, &receipt, &signer).unwrap();
        }
        assert!(write_legacy_roster(&hello, &mfa, &source, "windows-x86_64", &signer).is_err());
        assert!(write_legacy_roster(&hello, &mfa, &"c".repeat(40), platform, &signer).is_err());
        write_legacy_roster(&hello, &mfa, &source, platform, &signer).unwrap();
        let name = "modules-roster.json";
        let path = hello.join(name);
        let detached = fs::read_to_string(hello.join(format!("{name}.minisig"))).unwrap();
        signer
            .verify(&path, &detached, &format!("file={name} sourceSha={source}"))
            .unwrap();
        let catalog: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(
            catalog["legacyUpgrade"],
            json!(["taomni-plugin-hello-plugin", "taomni-plugin-mfa"])
        );
        for id in catalog["legacyUpgrade"].as_array().unwrap() {
            assert!(catalog["plugins"][id.as_str().unwrap()]["platforms"][platform].is_object());
        }
        let later = "modules-roster-with-optional.json";
        let path = hello.join(later);
        let signature = fs::read_to_string(hello.join(format!("{later}.minisig"))).unwrap();
        signer
            .verify(
                &path,
                &signature,
                &format!("file={later} sourceSha={source}"),
            )
            .unwrap();
        let latest: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(latest["sequence"], 44);
        assert_eq!(latest["legacyUpgrade"], json!(["taomni-plugin-mfa"]));
        assert_eq!(latest["plugins"], catalog["plugins"]);
        fs::write(mfa.join("modules.json"), b"changed catalog").unwrap();
        assert!(write_legacy_roster(&hello, &mfa, &source, platform, &signer).is_err());
    }

    #[test]
    fn signs_official_loopback_metadata_and_optional_module_catalogs() {
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
        for (name, sequence, count) in [
            ("modules-baseline.json", 43, 0),
            ("modules-new.json", 44, 1),
        ] {
            let path = root.join(name);
            let catalog: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(catalog["sequence"], sequence);
            assert_eq!(catalog["legacyUpgrade"], json!([]));
            assert_eq!(catalog["plugins"].as_object().unwrap().len(), count);
            let signature = fs::read_to_string(root.join(format!("{name}.minisig"))).unwrap();
            let comment = format!("file={name} sourceSha={}", "b".repeat(40));
            signer.verify(&path, &signature, &comment).unwrap();
        }
        let mut forbidden = receipt;
        forbidden["id"] = json!("taomni-plugin-third-party");
        assert!(write(root, &forbidden, &signer).is_err());

        for slug in ["servers", "sockscap"] {
            let business_dir = tempfile::tempdir().unwrap();
            let business_root = business_dir.path();
            let id = format!("taomni-plugin-{slug}");
            let archive = format!("{slug}.taomni-plugin");
            let business_receipt = json!({
                "id": id, "slug": slug, "version": "0.1.3", "coreApiVersion": "1",
                "platform": "linux-x86_64", "archive": archive, "sha256": "c".repeat(64),
                "size": 24, "sourceSha": "d".repeat(40),
            });
            fs::write(
                business_root.join("module.json"),
                json!({"name": slug, "kind": "local-server", "permissions": ["fs.dataDir"]})
                    .to_string(),
            )
            .unwrap();
            fs::write(
                business_root.join(format!("{archive}.minisig")),
                "exact package signature\n",
            )
            .unwrap();
            write(business_root, &business_receipt, &signer).unwrap();
            let catalog: Value =
                serde_json::from_slice(&fs::read(business_root.join("modules.json")).unwrap())
                    .unwrap();
            assert_eq!(catalog["plugins"][&id]["slug"], json!(slug));
        }
    }
}
