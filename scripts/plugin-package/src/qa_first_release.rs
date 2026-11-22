//! Build the loopback feed for a first installation of the real release roster.

use std::{
    fs::{self, File},
    path::Path,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value, json};

use crate::{PLATFORMS, qa_catalog, sha256, signing::ReleaseSigner, string, valid_slug};

const ROSTER: &str = include_str!("../../../src-tauri/plugins/legacy-upgrade.json");
const CATALOG: &str = "modules-first-release.json";

struct Build<'a> {
    sha: &'a str,
    run: &'a str,
    date: &'a str,
}

pub fn write(artifacts: &Path, output: &Path) -> Result<()> {
    ensure!(
        std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true"),
        "first-release QA signing requires a hosted build"
    );
    let sha = std::env::var("GITHUB_SHA")?;
    let run = std::env::var("GITHUB_RUN_ID")?;
    let date = std::env::var("MODULE_UPDATED_AT")?;
    let roster: Vec<String> = serde_json::from_str(ROSTER)?;
    let source = Path::new("src-tauri/plugins");
    let signer = ReleaseSigner::from_environment()?;
    assemble(
        &roster,
        source,
        artifacts,
        output,
        &Build {
            sha: &sha,
            run: &run,
            date: &date,
        },
        &signer,
    )
}

fn assemble(
    roster: &[String],
    sources: &Path,
    artifacts: &Path,
    output: &Path,
    build: &Build,
    signer: &ReleaseSigner,
) -> Result<()> {
    let (sha, run) = (build.sha, build.run);
    ensure!(
        sha.len() == 40
            && sha.bytes().all(|c| c.is_ascii_hexdigit())
            && !run.is_empty()
            && run.bytes().all(|c| c.is_ascii_digit()),
        "invalid build identity"
    );
    ensure!(
        !roster.is_empty() && !output.exists(),
        "expected an initial roster and a new destination"
    );
    let mut plugins = Map::new();
    let mut receipts = Vec::new();
    for id in roster {
        let slug = id
            .strip_prefix("taomni-plugin-")
            .filter(|slug| valid_slug(slug))
            .context("invalid first-release module ID")?;
        ensure!(
            !plugins.contains_key(id),
            "duplicate first-release module {id}"
        );
        let source: Value =
            serde_json::from_reader(File::open(sources.join(slug).join("module.json"))?)?;
        ensure!(
            source["id"] == *id
                && source["slug"] == slug
                && source["coreApiVersion"] == "1"
                && matches!(source["status"].as_str(), Some("provisional" | "stable"))
                && !string(&source, "description")?.trim().is_empty(),
            "invalid first-release source for {id}"
        );
        let mut entry = json!({});
        for key in [
            "id",
            "slug",
            "name",
            "version",
            "coreApiVersion",
            "description",
            "kind",
            "permissions",
        ] {
            entry[key] = source[key].clone();
        }
        let mut targets = Map::new();
        let declared = source["platforms"]
            .as_array()
            .filter(|list| !list.is_empty())
            .context("missing supported platforms")?;
        for value in declared {
            let platform = value
                .as_str()
                .filter(|platform| PLATFORMS.contains(platform))
                .context("invalid supported platform")?;
            ensure!(
                !targets.contains_key(platform),
                "duplicate target for {slug}"
            );
            let artifact = format!("module-signed-{slug}-{platform}-{run}");
            let (asset, receipt) = verified_asset(
                &artifacts.join(&artifact).join("signed-module"),
                &source,
                platform,
                sha,
                signer,
            )
            .with_context(|| format!("first-release package {slug}/{platform}"))?;
            targets.insert(platform.to_owned(), asset);
            receipts.push(json!({"artifact": artifact, "package": receipt}));
        }
        entry["platforms"] = Value::Object(targets);
        plugins.insert(id.clone(), entry);
    }
    let catalog = json!({
        "coreApiVersion": "1", "sequence": 42, "updatedAt": build.date,
        "legacyUpgrade": roster, "plugins": plugins
    });
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let staging = tempfile::tempdir_in(parent)?;
    qa_catalog::sign_catalog(staging.path(), CATALOG, &catalog, sha, signer)?;
    let receipt = json!({"sourceSha": sha, "runId": run, "catalogSha256": sha256(&staging.path().join(CATALOG))?, "packages": receipts});
    fs::write(
        staging.path().join("receipt.json"),
        serde_json::to_vec_pretty(&receipt)?,
    )?;
    fs::rename(staging.path(), output)?;
    Ok(())
}

#[cfg(test)]
mod tests;

fn verified_asset(
    directory: &Path,
    source: &Value,
    platform: &str,
    sha: &str,
    signer: &ReleaseSigner,
) -> Result<(Value, Value)> {
    let id = string(source, "id")?;
    let version = string(source, "version")?;
    semver::Version::parse(version)?;
    let archive = format!("{id}-{version}-{platform}.taomni-plugin");
    let receipt: Value = serde_json::from_reader(File::open(directory.join("provenance.json"))?)?;
    let detached = format!("{archive}.minisig");
    ensure!(
        receipt["archive"] == archive
            && receipt["signature"] == detached
            && receipt["sourceSha"] == sha
            && receipt["id"] == id
            && receipt["slug"] == source["slug"]
            && receipt["platform"] == platform
            && receipt["version"] == version
            && receipt["coreApiVersion"] == source["coreApiVersion"],
        "package identity differs from this build"
    );
    let path = directory.join(&archive);
    let signature = fs::read_to_string(directory.join(detached))?;
    let digest = sha256(&path)?;
    let size = fs::metadata(&path)?.len();
    ensure!(
        receipt["sha256"] == digest && receipt["size"] == size,
        "package content differs from its receipt"
    );
    let api = string(source, "coreApiVersion")?;
    signer.verify(
        &path,
        &signature,
        &format!(
            "id={id} version={version} platform={platform} coreApiVersion={api} sha256={digest}"
        ),
    )?;
    let mut zip = zip::ZipArchive::new(File::open(&path)?)?;
    let manifest = zip.by_name("module.json")?;
    ensure!(manifest.size() <= 128 * 1024, "oversized module manifest");
    let packed: Value = serde_json::from_reader(manifest)?;
    let mut expected = source.clone();
    if platform.starts_with("windows-")
        && let Some(host) = source["entry"]["host"]
            .as_str()
            .filter(|host| !host.ends_with(".exe"))
    {
        expected["entry"]["host"] = format!("{host}.exe").into();
    }
    ensure!(
        expected == packed,
        "signed package manifest differs from its source"
    );
    Ok((
        json!({"url": format!("{}/{archive}", qa_catalog::ORIGIN), "size": size, "sha256": digest, "signature": signature.trim()}),
        receipt,
    ))
}
