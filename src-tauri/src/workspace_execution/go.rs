use super::*;

pub(super) fn go_main_regex() -> &'static Regex {
    static MAIN: OnceLock<Regex> = OnceLock::new();
    MAIN.get_or_init(|| {
        Regex::new(r"(?s)\bpackage\s+main\b.*\bfunc\s+main\s*\(").expect("valid Go main regex")
    })
}

pub(super) fn source_directories(
    root: &Path,
    extension: &str,
    marker: &Regex,
) -> Vec<(PathBuf, PathBuf)> {
    let mut found = BTreeMap::<PathBuf, PathBuf>::new();
    for entry in WalkBuilder::new(root)
        .max_depth(Some(MAX_MANIFEST_DEPTH))
        .hidden(false)
        .filter_entry(manifest_entry)
        .build()
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some(extension) {
            continue;
        }
        let Ok(text) = read_text(path) else { continue };
        if marker.is_match(&text) {
            if let Some(parent) = path.parent() {
                found
                    .entry(parent.to_path_buf())
                    .or_insert_with(|| path.to_path_buf());
            }
        }
    }
    found.into_iter().collect()
}

pub(super) fn add_go(
    builder: &mut ModelBuilder,
    manifest: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("go", manifest, &["go"], "go");
    let go = builder.tool(
        root,
        config,
        "go",
        "Go",
        &[],
        &["go"],
        "Install the Go toolchain, or configure its executable for this workspace.",
    );
    let builds = add_common_builds(
        builder,
        &project,
        &go,
        &[
            ("Build all packages", "build", &["build", "./..."]),
            ("Test all packages", "test", &["test", "./..."]),
            ("Vet all packages", "check", &["vet", "./..."]),
            ("Clean build cache", "clean", &["clean"]),
        ],
    );
    let delve = builder.tool(
        root,
        config,
        "delve",
        "Delve DAP",
        &[],
        &["dlv"],
        "Install Delve with `go install github.com/go-delve/delve/cmd/dlv@latest`.",
    );
    for (directory, source) in source_directories(root, "go", go_main_regex()) {
        let relative = directory.strip_prefix(root).unwrap_or(&directory);
        let package = if relative.as_os_str().is_empty() {
            ".".to_string()
        } else {
            format!("./{}", relative.to_string_lossy().replace('\\', "/"))
        };
        let label = if package == "." {
            project.module.clone()
        } else {
            package.clone()
        };
        let source_file = Some(path_string(&source));
        let debug_id = builder.debug(
            &project,
            &format!("Debug {label}"),
            "delve",
            &delve,
            builds.get("build").cloned().into_iter().collect(),
            source_file.clone(),
            json!({ "name": label, "type": "go", "request": "launch", "mode": "debug", "program": path_string(&directory), "cwd": project.root, "args": [] }),
            Some(json!({ "kind": "managedTcp", "args": ["dap", "--listen=127.0.0.1:${port}", "--log=false"] })),
        );
        builder.run(
            &project,
            &format!("Run {label}"),
            "main-package",
            command(
                &go,
                vec!["run".to_string(), package, "--".to_string()],
                root,
            ),
            source_file,
            builds.get("build").cloned().into_iter().collect(),
            Some(debug_id),
        );
    }
    if let Some(active) = active_in_project(active_file, root, &["go"]) {
        if !builder
            .run_configurations
            .iter()
            .any(|item| item.source_file.as_deref() == Some(path_string(&active).as_str()))
        {
            let command = command(
                &go,
                vec!["run".to_string(), path_string(&active), "--".to_string()],
                root,
            );
            builder.run(
                &project,
                &format!(
                    "Run {}",
                    active.file_name().unwrap_or_default().to_string_lossy()
                ),
                "file",
                command,
                Some(path_string(&active)),
                Vec::new(),
                None,
            );
        }
    }
    Ok(())
}
