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
    if matches!(
        args.peek().map(String::as_str),
        Some("--sign-catalog" | "--verify-catalog")
    ) {
        let operation = args.next().expect("catalog operation");
        let path = args
            .next()
            .context("expected the staged catalog directory")?;
        ensure!(
            args.next().is_none(),
            "catalog operations accept one directory"
        );
        return if operation == "--sign-catalog" {
            taomni_plugin_package::release_catalog::sign_staged(Path::new(&path))
        } else {
            taomni_plugin_package::release_catalog::verify_staged(Path::new(&path))
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
                "--qa-catalog"
            ]
            .contains(&flag.as_str()),
            "expected --payload DIR --platform PLATFORM --output DIR --source-sha COMMIT"
        );
        let value = args.next().context("missing option value")?;
        ensure!(values.insert(flag, value).is_none(), "repeated option");
    }
    let get = |flag| values.get(flag).with_context(|| format!("missing {flag}"));
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
    }
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}
