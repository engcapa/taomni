use super::*;

pub(super) fn add_dotnet(
    builder: &mut ModelBuilder,
    manifest: &Path,
    config: Option<&WorkspaceToolConfig>,
) {
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("dotnet", manifest, &["csharp"], "dotnet");
    let dotnet = builder.tool(
        root,
        config,
        "dotnet",
        ".NET SDK",
        &[],
        &["dotnet"],
        "Install a compatible .NET SDK, or configure dotnet for this workspace.",
    );
    let manifest_arg = path_string(manifest);
    let builds = add_common_builds(
        builder,
        &project,
        &dotnet,
        &[
            ("Restore", "restore", &["restore", manifest_arg.as_str()]),
            (
                "Build (Debug)",
                "build",
                &["build", manifest_arg.as_str(), "--configuration", "Debug"],
            ),
            (
                "Test",
                "test",
                &["test", manifest_arg.as_str(), "--configuration", "Debug"],
            ),
            (
                "Clean",
                "clean",
                &["clean", manifest_arg.as_str(), "--configuration", "Debug"],
            ),
        ],
    );
    builder.run(
        &project,
        &format!("Run {}", project.module),
        "project",
        command(
            &dotnet,
            vec![
                "run".to_string(),
                "--project".to_string(),
                manifest_arg,
                "--configuration".to_string(),
                "Debug".to_string(),
                "--".to_string(),
            ],
            root,
        ),
        None,
        builds.get("build").cloned().into_iter().collect(),
        None,
    );
    // netcoredbg needs a concrete build artifact. The provider intentionally
    // leaves Debug unavailable until MSBuild result parsing is implemented.
    builder.tool(root, config, "netcoredbg", "netcoredbg", &[], &["netcoredbg"], "Install netcoredbg and configure its executable. Debug also requires a resolved target framework artifact.");
}
