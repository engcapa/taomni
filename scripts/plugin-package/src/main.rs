use std::{collections::BTreeMap, path::Path};

use anyhow::{Context, Result, ensure};
use taomni_plugin_package::{package, signing::ReleaseSigner};

fn main() {
    if let Err(error) = run() {
        // Signing errors deliberately omit the supplied key/password and the
        // upstream parser's input. Never enable debug-printing of signer state.
        eprintln!("Plugin package failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1).peekable();
    if args
        .peek()
        .is_some_and(|argument| argument == "--qa-first-release-roster")
    {
        args.next();
        let directories: Vec<_> = args.collect();
        let [artifacts, output] = directories.as_slice() else {
            anyhow::bail!("expected --qa-first-release-roster SIGNED_ARTIFACTS OUTPUT");
        };
        return taomni_plugin_package::qa_first_release::write(
            Path::new(artifacts),
            Path::new(output),
        );
    }
    if args
        .peek()
        .is_some_and(|argument| argument == "--verify-release-roster")
    {
        args.next();
        let staged = args
            .next()
            .context("expected the staged release directory")?;
        let previous = args.next();
        ensure!(
            args.next().is_none(),
            "expected --verify-release-roster DIR [PREVIOUS_DIR]"
        );
        return taomni_plugin_package::release_catalog::verify_release_roster(
            Path::new(&staged),
            previous.as_deref().map(Path::new),
        );
    }
    if args
        .peek()
        .is_some_and(|argument| argument == "--prepare-catalog-update")
    {
        args.next();
        let arguments: Vec<_> = args.collect();
        let (previous, changed, output, allow_provisional) = match arguments.as_slice() {
            [previous, changed, output] => (previous, changed, output, false),
            [previous, changed, output, flag] if flag == "--rehearsal-allow-provisional" => {
                (previous, changed, output, true)
            }
            _ => anyhow::bail!(
                "expected --prepare-catalog-update PREVIOUS_DIR CHANGED_DIR OUTPUT_DIR [--rehearsal-allow-provisional]"
            ),
        };
        let assets = if allow_provisional {
            taomni_plugin_package::release_catalog::prepare_catalog_update_rehearsal(
                Path::new(previous),
                Path::new(changed),
                Path::new(output),
            )?
        } else {
            taomni_plugin_package::release_catalog::prepare_catalog_update(
                Path::new(previous),
                Path::new(changed),
                Path::new(output),
            )?
        };
        println!("{}", serde_json::to_string_pretty(&assets)?);
        return Ok(());
    }
    if matches!(
        args.peek().map(String::as_str),
        Some("--sign-catalog" | "--verify-catalog" | "--verify-catalog-signature")
    ) {
        let operation = args.next().expect("catalog operation");
        let path = args
            .next()
            .context("expected the staged catalog directory")?;
        let extra = args.next();
        ensure!(
            args.next().is_none(),
            "catalog operations accept one directory"
        );
        let allow_provisional = match (operation.as_str(), extra.as_deref()) {
            (_, None) => false,
            ("--sign-catalog" | "--verify-catalog", Some("--rehearsal-allow-provisional")) => true,
            _ => anyhow::bail!("catalog operations accept one directory"),
        };
        use taomni_plugin_package::release_catalog;
        let directory = Path::new(&path);
        return match (operation.as_str(), allow_provisional) {
            ("--sign-catalog", false) => release_catalog::sign_staged(directory),
            ("--sign-catalog", true) => release_catalog::sign_staged_rehearsal(directory),
            ("--verify-catalog-signature", false) => {
                release_catalog::verify_catalog_signature(directory)
            }
            ("--verify-catalog", false) => release_catalog::verify_staged(directory),
            ("--verify-catalog", true) => release_catalog::verify_staged_rehearsal(directory),
            _ => unreachable!("validated catalog operation"),
        };
    }
    let mut values = BTreeMap::new();
    while let Some(flag) = args.next() {
        ensure!(
            [
                "--payload",
                "--platform",
                "--output",
                "--source-sha",
                "--qa-catalog",
                "--qa-roster-root"
            ]
            .contains(&flag.as_str()),
            "expected --payload DIR --platform PLATFORM --output DIR --source-sha COMMIT"
        );
        let value = args.next().context("missing option value")?;
        ensure!(values.insert(flag, value).is_none(), "repeated option");
    }
    let get = |flag| values.get(flag).with_context(|| format!("missing {flag}"));
    ensure!(
        !values.contains_key("--qa-roster-root") || values.contains_key("--qa-catalog"),
        "a QA roster requires the QA catalog option"
    );
    let signer = ReleaseSigner::from_environment()?;
    let receipt = package(
        Path::new(get("--payload")?),
        get("--platform")?,
        Path::new(get("--output")?),
        get("--source-sha")?,
        &signer,
    )?;
    if let Some(value) = values.get("--qa-catalog") {
        ensure!(
            value == "true" && std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true"),
            "QA catalog signing is restricted to GitHub workflows"
        );
        taomni_plugin_package::qa_catalog::write(Path::new(get("--output")?), &receipt, &signer)?;
        if let Some(root) = values.get("--qa-roster-root") {
            taomni_plugin_package::qa_catalog::write_legacy_roster(
                Path::new(root),
                Path::new(get("--output")?),
                get("--source-sha")?,
                get("--platform")?,
                &signer,
            )?;
        }
    }
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}
