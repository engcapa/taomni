use super::*;

pub(super) fn swift_products(contents: &str) -> Vec<String> {
    let regex = Regex::new(r#"\.executable(?:Target)?\s*\(\s*name\s*:\s*"([^"]+)""#)
        .expect("valid Swift product regex");
    let mut products = regex
        .captures_iter(contents)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_string()))
        .collect::<Vec<_>>();
    products.sort();
    products.dedup();
    products
}

pub(super) fn add_swift(
    builder: &mut ModelBuilder,
    manifest: &Path,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let contents = read_text(manifest)?;
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("swiftpm", manifest, &["swift"], "swift");
    let swift = builder.tool(
        root,
        config,
        "swift",
        "Swift",
        &[],
        &["swift"],
        "Install a Swift toolchain, or configure its executable for this workspace.",
    );
    let builds = add_common_builds(
        builder,
        &project,
        &swift,
        &[
            (
                "Build (debug)",
                "build",
                &["build", "--configuration", "debug"],
            ),
            ("Test", "test", &["test"]),
            ("Clean", "clean", &["package", "clean"]),
        ],
    );
    let lldb = builder.tool(
        root,
        config,
        "lldb-dap",
        "LLDB DAP",
        &[],
        &["lldb-dap"],
        "Install lldb-dap from the Swift/LLVM toolchain, or configure its executable.",
    );
    for product in swift_products(&contents) {
        let debug_id = builder.debug(
            &project,
            &format!("Debug {product}"),
            "lldb",
            &lldb,
            builds.get("build").cloned().into_iter().collect(),
            None,
            json!({ "name": product, "request": "launch", "cwd": project.root, "args": [] }),
            Some(json!({ "kind": "swift", "command": swift.executable, "product": product })),
        );
        builder.run(
            &project,
            &format!("Run {product}"),
            "product",
            command(
                &swift,
                vec!["run".to_string(), product.clone(), "--".to_string()],
                root,
            ),
            None,
            builds.get("build").cloned().into_iter().collect(),
            Some(debug_id),
        );
    }
    Ok(())
}
