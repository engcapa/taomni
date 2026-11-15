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
    let mut args = std::env::args().skip(1);
    let mut values = BTreeMap::new();
    while let Some(flag) = args.next() {
        ensure!(
            ["--payload", "--platform", "--output", "--source-sha"].contains(&flag.as_str()),
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
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}
