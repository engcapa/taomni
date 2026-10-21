use super::*;

pub(super) fn add_cmake(
    builder: &mut ModelBuilder,
    manifest: &Path,
    config: Option<&WorkspaceToolConfig>,
) {
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("cmake", manifest, &["c", "cpp"], "cmake");
    let cmake = builder.tool(
        root,
        config,
        "cmake",
        "CMake",
        &[],
        &["cmake"],
        "Install CMake, or configure its executable for this workspace.",
    );
    let build_dir = root.join("build");
    let configure = builder.build(
        &project,
        "Configure (Debug)",
        "configure",
        command(
            &cmake,
            vec![
                "-S".to_string(),
                path_string(root),
                "-B".to_string(),
                path_string(&build_dir),
                "-DCMAKE_BUILD_TYPE=Debug".to_string(),
            ],
            root,
        ),
    );
    let build = builder.build(
        &project,
        "Build",
        "build",
        command(
            &cmake,
            vec![
                "--build".to_string(),
                path_string(&build_dir),
                "--config".to_string(),
                "Debug".to_string(),
            ],
            root,
        ),
    );
    if let Some(target) = builder
        .build_targets
        .iter_mut()
        .find(|target| target.id == build)
    {
        target.depends_on.push(configure);
    }
    builder.build(
        &project,
        "Run tests",
        "test",
        command(
            &cmake,
            vec![
                "--build".to_string(),
                path_string(&build_dir),
                "--target".to_string(),
                "test".to_string(),
                "--config".to_string(),
                "Debug".to_string(),
            ],
            root,
        ),
    );
    builder.build(
        &project,
        "Clean",
        "clean",
        command(
            &cmake,
            vec![
                "--build".to_string(),
                path_string(&build_dir),
                "--target".to_string(),
                "clean".to_string(),
            ],
            root,
        ),
    );
}
