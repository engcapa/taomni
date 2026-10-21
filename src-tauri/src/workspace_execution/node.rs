use super::*;

pub(super) fn package_manager(
    builder: &mut ModelBuilder,
    root: &Path,
    config: Option<&WorkspaceToolConfig>,
) -> ToolProbe {
    if root.join("pnpm-lock.yaml").is_file() {
        builder.tool(
            root,
            config,
            "pnpm",
            "pnpm",
            &[],
            &["pnpm"],
            "Install pnpm, or configure its executable for this workspace.",
        )
    } else if root.join("yarn.lock").is_file() {
        builder.tool(
            root,
            config,
            "yarn",
            "Yarn",
            &[],
            &["yarn"],
            "Install Yarn, or configure its executable for this workspace.",
        )
    } else {
        builder.tool(
            root,
            config,
            "npm",
            "npm",
            &[],
            &["npm"],
            "Install Node.js/npm, or configure npm for this workspace.",
        )
    }
}

pub(super) fn add_node(
    builder: &mut ModelBuilder,
    manifest: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let contents = read_text(manifest)?;
    let package: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("parse {}: {error}", manifest.display()))?;
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("node", manifest, &["javascript", "typescript"], "node");
    let manager = package_manager(builder, root, config);
    let node = builder.tool(
        root,
        config,
        "node",
        "Node.js",
        &[],
        &["node"],
        "Install Node.js, or configure its executable for this workspace.",
    );
    let js_debug = builder.tool(
        root,
        config,
        "js-debug",
        "JavaScript Debug Adapter",
        &[],
        &["js-debug-adapter"],
        "Install vscode-js-debug and configure its DAP adapter executable.",
    );
    if let Some(scripts) = package.get("scripts").and_then(Value::as_object) {
        let mut names = scripts.keys().cloned().collect::<Vec<_>>();
        names.sort();
        for name in names {
            let script_args = vec!["run".to_string(), name.clone(), "--".to_string()];
            if matches!(
                name.as_str(),
                "build" | "compile" | "clean" | "test" | "lint" | "check" | "typecheck"
            ) {
                let kind = match name.as_str() {
                    "clean" => "clean",
                    "test" => "test",
                    "lint" | "check" | "typecheck" => "check",
                    _ => "build",
                };
                builder.build(
                    &project,
                    &format!("Script: {name}"),
                    kind,
                    command(&manager, script_args, root),
                );
            } else if matches!(name.as_str(), "start" | "dev" | "serve")
                || name.starts_with("start:")
                || name.starts_with("dev:")
            {
                builder.run(
                    &project,
                    &format!("Script: {name}"),
                    "package-script",
                    command(&manager, script_args, root),
                    None,
                    Vec::new(),
                    None,
                );
            }
        }
    }
    if let Some(active) = active_in_project(
        active_file,
        root,
        &["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"],
    ) {
        let extension = active
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let runner = if matches!(extension, "ts" | "tsx" | "mts" | "cts") {
            let local_tsx = root.join("node_modules/.bin/tsx");
            let local_tsx_cmd = if cfg!(windows) {
                root.join("node_modules/.bin/tsx.cmd")
            } else {
                local_tsx
            };
            resolve_tool(
                root,
                "tsx",
                "tsx",
                None,
                &[],
                &[local_tsx_cmd.to_str().unwrap_or("tsx"), "tsx", "ts-node"],
                "Install the project `tsx` or `ts-node` runner before running TypeScript directly.",
            )
        } else {
            node.clone()
        };
        let source_file = Some(path_string(&active));
        let debug_id = builder.debug(
            &project,
            &format!("Debug {}", active.file_name().unwrap_or_default().to_string_lossy()),
            "node",
            &js_debug,
            Vec::new(),
            source_file.clone(),
            json!({ "name": "Node", "type": "pwa-node", "request": "launch", "program": path_string(&active), "cwd": project.root, "args": [], "sourceMaps": true, "skipFiles": ["<node_internals>/**"] }),
            Some(json!({ "kind": "stdio", "args": [] })),
        );
        builder.run(
            &project,
            &format!(
                "Run {}",
                active.file_name().unwrap_or_default().to_string_lossy()
            ),
            "file",
            command(&runner, vec![path_string(&active), "--".to_string()], root),
            source_file,
            Vec::new(),
            Some(debug_id),
        );
    }
    Ok(())
}
