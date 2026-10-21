use super::*;

pub(super) fn add_cargo(
    builder: &mut ModelBuilder,
    manifest: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let contents = read_text(manifest)?;
    let parsed: toml::Value = toml::from_str(&contents)
        .map_err(|error| format!("parse {}: {error}", manifest.display()))?;
    if parsed.get("package").is_none() {
        return Ok(());
    }
    let root = manifest.parent().unwrap_or(manifest);
    let package = parsed
        .get("package")
        .and_then(|value| value.get("name"))
        .and_then(toml::Value::as_str)
        .unwrap_or_else(|| {
            root.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("package")
        });
    let project = builder.project("cargo", manifest, &["rust"], "cargo");
    let cargo = builder.tool(
        root,
        config,
        "cargo",
        "Cargo",
        &[],
        &["cargo"],
        "Install Rust with rustup, or configure the Cargo executable for this workspace.",
    );
    let builds = add_common_builds(
        builder,
        &project,
        &cargo,
        &[
            (
                "Check",
                "check",
                &["check", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
            (
                "Build",
                "build",
                &["build", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
            (
                "Test",
                "test",
                &["test", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
            (
                "Clippy",
                "check",
                &["clippy", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
            (
                "Clean",
                "clean",
                &["clean", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
        ],
    );
    let lldb = builder.tool(
        root,
        config,
        "lldb-dap",
        "LLDB DAP",
        &[],
        &["lldb-dap"],
        "Install lldb-dap (or configure Code Workspace to use its executable).",
    );
    let mut bins = Vec::<(String, Option<PathBuf>, String)>::new();
    if root.join("src/main.rs").is_file() {
        bins.push((
            package.to_string(),
            Some(root.join("src/main.rs")),
            "bin".to_string(),
        ));
    }
    if let Some(entries) = parsed.get("bin").and_then(toml::Value::as_array) {
        for entry in entries {
            let Some(name) = entry.get("name").and_then(toml::Value::as_str) else {
                continue;
            };
            let source = entry
                .get("path")
                .and_then(toml::Value::as_str)
                .map(|path| root.join(path));
            bins.push((name.to_string(), source, "bin".to_string()));
        }
    }
    let examples = root.join("examples");
    if let Ok(entries) = fs::read_dir(&examples) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("rs") {
                if let Some(name) = path.file_stem().and_then(|value| value.to_str()) {
                    bins.push((name.to_string(), Some(path), "example".to_string()));
                }
            }
        }
    }
    bins.sort_by(|a, b| a.0.cmp(&b.0));
    bins.dedup_by(|a, b| a.0 == b.0 && a.2 == b.2);
    for (name, source, target_kind) in bins {
        let selector = if target_kind == "example" {
            "--example"
        } else {
            "--bin"
        };
        let args = vec![
            "run".to_string(),
            "--manifest-path".to_string(),
            path_string(manifest),
            selector.to_string(),
            name.clone(),
            "--".to_string(),
        ];
        let source_file = source.as_ref().map(|path| path_string(path));
        let debug_id = builder.debug(
            &project,
            &format!("Debug {name}"),
            "lldb",
            &lldb,
            builds.get("build").cloned().into_iter().collect(),
            source_file.clone(),
            json!({ "name": name, "request": "launch", "cwd": project.root, "args": [] }),
            Some(json!({
                "kind": "cargo",
                "command": cargo.executable,
                "args": ["build", "--manifest-path", path_string(manifest), selector, name, "--message-format=json"],
                "targetName": name,
            })),
        );
        builder.run(
            &project,
            &format!("Run {name}"),
            target_kind.as_str(),
            command(&cargo, args, root),
            source_file,
            builds.get("build").cloned().into_iter().collect(),
            Some(debug_id),
        );
    }
    if let Some(active) = active_in_project(active_file, root, &["rs"]) {
        if !builder
            .run_configurations
            .iter()
            .any(|config| config.source_file.as_deref() == Some(path_string(&active).as_str()))
        {
            // Library-only Rust files are buildable but not independently runnable.
        }
    }
    Ok(())
}
