use super::*;
// ---- Cross-platform tool resolution (M11 build/run robustness) ----
//
// These tests inject `HostPlatform` and `PATH` explicitly so the Windows
// `.cmd`/`.bat` resolution and launch planning are exercised on non-Windows
// CI too (the production entry points use `HostPlatform::current()`).

#[test]
fn resolves_windows_batch_wrapper_before_configured_or_path() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    fs::write(dir.path().join("mvnw.cmd"), "@echo off").unwrap();
    let config = WorkspaceToolConfig {
        maven: Some("C:/tools/mvn.cmd".into()),
        gradle: None,
        ..WorkspaceToolConfig::default()
    };
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Maven,
        Some(&config),
        HostPlatform::Windows,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Wrapper);
    assert!(resolution.available);
    assert!(resolution.executable.ends_with("mvnw.cmd"));
    // PowerShell call operator + absolute path (never the fragile bare `.\mvnw.cmd`).
    let runner = resolution.task_runner(HostPlatform::Windows);
    assert!(runner.starts_with("& '"));
    assert!(runner.contains("mvnw.cmd"));
}

#[test]
fn walks_up_to_find_wrapper_in_monorepo() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
    let module = dir.path().join("services/api");
    fs::create_dir_all(&module).unwrap();
    let resolution = resolve_build_tool_with_path(
        &module,
        dir.path(),
        BuildTool::Maven,
        None,
        HostPlatform::Unix,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Wrapper);
    assert!(resolution.executable.ends_with("mvnw"));
}

#[test]
fn falls_back_to_configured_executable_then_reports_missing() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    let mvn = dir.path().join("custom-mvn");
    fs::write(&mvn, "#!/bin/sh").unwrap();

    // A configured path with a directory separator resolves relative to the
    // workspace root; a bare name (no separator) is a PATH lookup instead.
    let config = WorkspaceToolConfig {
        maven: Some("./custom-mvn".into()),
        gradle: None,
        ..WorkspaceToolConfig::default()
    };
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Maven,
        Some(&config),
        HostPlatform::Unix,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Configured);
    assert!(resolution.available);
    assert_eq!(resolution.executable, fs::canonicalize(&mvn).unwrap_or(mvn));

    // A configured executable that does not exist yields a clear diagnostic
    // rather than a shell "not recognized" error at run time.
    let missing = WorkspaceToolConfig {
        maven: Some("nope-not-here".into()),
        gradle: None,
        ..WorkspaceToolConfig::default()
    };
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Maven,
        Some(&missing),
        HostPlatform::Unix,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Configured);
    assert!(!resolution.available);
    assert!(resolution.require_available().is_err());
    assert!(
        resolution
            .diagnostic
            .as_deref()
            .unwrap()
            .contains("nope-not-here")
    );
}

#[test]
fn reports_missing_tool_when_no_wrapper_config_or_path() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("build.gradle"), "plugins {}").unwrap();
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Gradle,
        None,
        HostPlatform::Unix,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Path);
    assert!(!resolution.available);
    let error = resolution.require_available().unwrap_err();
    assert!(error.contains("Gradle"));
    assert!(error.contains("gradlew"));
}

#[test]
fn plans_windows_batch_launch_via_cmd_exe() {
    let plan = plan_tool_launch(
        Path::new(r"C:\proj\mvnw.cmd"),
        &["-B".into(), "dependency:tree".into()],
        HostPlatform::Windows,
    );
    assert_eq!(plan.program, "cmd.exe");
    assert_eq!(plan.args[0], "/D");
    assert_eq!(plan.args[1], "/S");
    assert_eq!(plan.args[2], "/C");
    // The whole command line is one argument, wrapper quoted, args appended.
    assert!(plan.args[3].contains(r"C:\proj\mvnw.cmd"));
    assert!(plan.args[3].contains("dependency:tree"));
}

#[test]
fn plans_direct_launch_for_plain_executable() {
    let plan = plan_tool_launch(
        Path::new("/usr/bin/gradle"),
        &["dependencies".into()],
        HostPlatform::Unix,
    );
    assert_eq!(plan.program, "/usr/bin/gradle");
    assert_eq!(plan.args, vec!["dependencies".to_string()]);
}

#[test]
fn build_task_tree_surfaces_missing_tool_diagnostic() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    // No wrapper, no config; PATH lookup disabled → execution carries the error.
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Maven,
        None,
        HostPlatform::Unix,
        None,
    );
    let execution = resolution.execution(&["package"]);
    assert_eq!(execution.args, vec!["package".to_string()]);
    assert!(execution.error.is_some());
}
