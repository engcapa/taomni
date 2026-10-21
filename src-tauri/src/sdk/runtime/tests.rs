use super::environment::build_workspace_environment;
use super::fingerprint::fingerprint;
use super::model::WorkspaceSdkEnvironment;
use super::paths::normalize_inherited_home;
use super::paths::path_string;
use crate::sdk::SdkBindingMode;
use crate::sdk::SdkInstallation;
use crate::sdk::SdkKind;
use crate::sdk::SdkRegistry;
use crate::sdk::SdkRole;
use crate::sdk::SdkStatus;
use crate::sdk::resolve::ResolvedSdkStatus;
use std::collections::BTreeMap;
use std::path::Path;

use super::super::detect::{
    ProjectBuildSystem, ProjectSdkProfile, SdkConfidence, SdkRequirement, WorkspaceSdkAnalysis,
};
use super::super::resolve::{ResolvedSdk, ResolvedSdkSource, WorkspaceSdkResolution};
use super::super::{SdkDefault, SdkOrigin, WorkspaceSdkBinding};

fn installation(id: &str, kind: SdkKind, version: &str, location: &str) -> SdkInstallation {
    SdkInstallation {
        id: id.to_string(),
        kind,
        name: format!("{kind:?} {version}"),
        location: location.to_string(),
        executables: BTreeMap::new(),
        version: Some(version.to_string()),
        vendor: None,
        architecture: None,
        origin: SdkOrigin::Manual,
        status: SdkStatus::Ready,
        last_error: None,
        last_probed_at: None,
    }
}

fn resolved(scope: &str, kind: SdkKind, role: SdkRole, sdk: SdkInstallation) -> ResolvedSdk {
    ResolvedSdk {
        scope_path: scope.to_string(),
        kind,
        role,
        requirement: SdkRequirement {
            kind,
            role,
            constraint: None,
            required_location: None,
            managed_by_build: false,
            source: "test".to_string(),
            confidence: SdkConfidence::High,
            evidence: Vec::new(),
        },
        installation: Some(sdk),
        source: ResolvedSdkSource::AutoMatch,
        status: ResolvedSdkStatus::Resolved,
        reason: "test".to_string(),
    }
}

fn resolution(root: &str, scope: &str, resolved: Vec<ResolvedSdk>) -> WorkspaceSdkResolution {
    WorkspaceSdkResolution {
        analysis: WorkspaceSdkAnalysis {
            workspace_root: root.to_string(),
            profiles: vec![ProjectSdkProfile {
                scope_path: scope.to_string(),
                relative_path: ".".to_string(),
                display_name: "test".to_string(),
                build_systems: vec![ProjectBuildSystem::Gradle],
                languages: vec![SdkKind::Kotlin],
                requirements: Vec::new(),
                kotlin: None,
            }],
            warnings: Vec::new(),
        },
        resolved,
    }
}

#[test]
fn separates_jdtls_tooling_jdk_from_project_jdk() {
    let root = if cfg!(windows) { r"C:\repo" } else { "/repo" };
    let project = installation("jdk-17", SdkKind::Java, "17.0.12", "/sdk/jdk-17");
    let tooling = installation("jdk-21", SdkKind::Java, "21.0.6", "/sdk/jdk-21");
    let registry = SdkRegistry {
        installations: vec![project.clone(), tooling.clone()],
        defaults: vec![SdkDefault {
            kind: SdkKind::Java,
            sdk_id: tooling.id.clone(),
        }],
        ..SdkRegistry::default()
    };
    let resolution = resolution(
        root,
        root,
        vec![resolved(root, SdkKind::Java, SdkRole::Project, project)],
    );

    let environment = build_workspace_environment(&resolution, &registry, Path::new(root));

    assert_eq!(
        environment.project_java_home.as_deref(),
        Some("/sdk/jdk-17")
    );
    assert_eq!(
        environment.tooling_java_home.as_deref(),
        Some("/sdk/jdk-21")
    );
    assert_eq!(
        environment.environment.get("JAVA_HOME").map(String::as_str),
        Some("/sdk/jdk-17")
    );
    assert!(
        environment
            .java_runtimes
            .iter()
            .any(|runtime| runtime.name == "JavaSE-17" && runtime.default)
    );
}

#[test]
fn incompatible_manual_tooling_binding_is_visible_and_not_applied() {
    let root = if cfg!(windows) { r"C:\repo" } else { "/repo" };
    let old = installation("jdk-17", SdkKind::Java, "17", "/sdk/jdk-17");
    let registry = SdkRegistry {
        installations: vec![old.clone()],
        bindings: vec![WorkspaceSdkBinding {
            scope_path: root.to_string(),
            kind: SdkKind::Java,
            role: SdkRole::Tooling,
            mode: SdkBindingMode::Manual,
            sdk_id: Some(old.id),
            updated_at: "now".to_string(),
        }],
        ..SdkRegistry::default()
    };
    let resolution = resolution(root, root, Vec::new());

    let environment = build_workspace_environment(&resolution, &registry, Path::new(root));

    assert!(environment.tooling_java_home.is_none());
    assert!(
        environment
            .tooling_java_error
            .as_deref()
            .is_some_and(|error| error.contains("requires JDK 21+"))
    );
}

#[test]
fn strips_verbatim_prefix_from_java_home_and_path_entries() {
    // A registry entry saved with a Windows `\\?\` verbatim prefix must not
    // reach JAVA_HOME / PATH: cmd.exe and batch launchers (mvn.cmd) resolve
    // `%JAVA_HOME%\bin\java.exe` and fail with "path not found" on `\\?\`.
    let root = if cfg!(windows) { r"C:\repo" } else { "/repo" };
    let mut project = installation(
        "jdk-21",
        SdkKind::Java,
        "21.0.4",
        r"\\?\C:\Program Files\Java\jdk-21",
    );
    project.executables = BTreeMap::from([(
        "java".to_string(),
        r"\\?\C:\Program Files\Java\jdk-21\bin\java.exe".to_string(),
    )]);
    let registry = SdkRegistry {
        installations: vec![project.clone()],
        ..SdkRegistry::default()
    };
    let resolution = resolution(
        root,
        root,
        vec![resolved(root, SdkKind::Java, SdkRole::Project, project)],
    );

    let environment = build_workspace_environment(&resolution, &registry, Path::new(root));

    // Core of the bug: JAVA_HOME must be a plain path (pure string strip,
    // identical on every host).
    assert_eq!(
        environment.environment.get("JAVA_HOME").map(String::as_str),
        Some(r"C:\Program Files\Java\jdk-21")
    );
    assert_eq!(
        environment.project_java_home.as_deref(),
        Some(r"C:\Program Files\Java\jdk-21")
    );
    // Invariant that holds on every host: nothing emitted keeps a verbatim
    // prefix (env values, PATH entries, runtime paths).
    assert!(
        environment
            .environment
            .values()
            .chain(environment.path_entries.iter())
            .chain(
                environment
                    .java_runtimes
                    .iter()
                    .map(|runtime| &runtime.path)
            )
            .all(|value| !value.contains(r"\\?\") && !value.contains("//?/")),
        "no emitted path may keep a verbatim prefix: env={:?} path={:?}",
        environment.environment,
        environment.path_entries,
    );
    // The executable-derived PATH entry maps to `<home>\bin` on Windows,
    // where `\\?\...\bin\java.exe`'s parent resolves natively.
    #[cfg(windows)]
    assert_eq!(
        environment.path_entries.first().map(String::as_str),
        Some(r"C:\Program Files\Java\jdk-21\bin")
    );
}

#[test]
fn normalizes_inherited_java_home_values() {
    assert_eq!(
        normalize_inherited_home(r"  \\?\C:\Program Files\Java\jdk-21  ").as_deref(),
        Some(r"C:\Program Files\Java\jdk-21")
    );
    assert_eq!(normalize_inherited_home(" \t\n"), None);
}

#[test]
fn applies_all_standalone_sdks_and_keeps_java_home_aligned_with_path() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let project_java_path = root.join("jdk-17");
    let launcher_java_path = root.join("jdk-21");
    let python_path = root.join(".venv");
    let kotlin_path = root.join("kotlin");
    let scala_path = root.join("scala");
    for path in [
        &project_java_path,
        &launcher_java_path,
        &python_path,
        &kotlin_path,
        &scala_path,
    ] {
        std::fs::create_dir_all(path.join("bin")).unwrap();
    }
    std::fs::write(python_path.join("pyvenv.cfg"), "home = test\n").unwrap();

    let project_java = installation(
        "jdk-17",
        SdkKind::Java,
        "17.0.12",
        &path_string(&project_java_path),
    );
    let launcher_java = installation(
        "jdk-21",
        SdkKind::Java,
        "21.0.6",
        &path_string(&launcher_java_path),
    );
    let python = installation(
        "python",
        SdkKind::Python,
        "3.12.9",
        &path_string(&python_path),
    );
    let kotlin = installation(
        "kotlin",
        SdkKind::Kotlin,
        "2.1.20",
        &path_string(&kotlin_path),
    );
    let scala = installation("scala", SdkKind::Scala, "3.6.4", &path_string(&scala_path));
    let registry = SdkRegistry {
        installations: vec![
            project_java.clone(),
            launcher_java.clone(),
            python.clone(),
            kotlin.clone(),
            scala.clone(),
        ],
        ..SdkRegistry::default()
    };
    let root_string = path_string(root);
    let resolution = resolution(
        &root_string,
        &root_string,
        vec![
            resolved(&root_string, SdkKind::Java, SdkRole::Project, project_java),
            resolved(
                &root_string,
                SdkKind::Java,
                SdkRole::Launcher,
                launcher_java,
            ),
            resolved(&root_string, SdkKind::Python, SdkRole::Project, python),
            resolved(&root_string, SdkKind::Kotlin, SdkRole::Compiler, kotlin),
            resolved(&root_string, SdkKind::Scala, SdkRole::Compiler, scala),
        ],
    );

    let environment = build_workspace_environment(&resolution, &registry, root);

    assert_eq!(
        environment.environment.get("JAVA_HOME").map(String::as_str),
        Some(path_string(&launcher_java_path).as_str())
    );
    assert_eq!(
        environment
            .environment
            .get("VIRTUAL_ENV")
            .map(String::as_str),
        Some(path_string(&python_path).as_str())
    );
    assert_eq!(
        environment
            .environment
            .get("KOTLIN_HOME")
            .map(String::as_str),
        Some(path_string(&kotlin_path).as_str())
    );
    assert_eq!(
        environment
            .environment
            .get("SCALA_HOME")
            .map(String::as_str),
        Some(path_string(&scala_path).as_str())
    );
    assert_eq!(
        environment.path_entries.first().map(String::as_str),
        Some(path_string(&launcher_java_path.join("bin")).as_str())
    );
    assert_eq!(
        environment.path_entries.get(1).map(String::as_str),
        Some(path_string(&project_java_path.join("bin")).as_str())
    );
}

#[test]
fn fingerprint_is_stable_across_packages_in_the_same_project_scope() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let package_a = root.join("src/main/java/com/example/a");
    let package_b = root.join("src/main/java/com/example/b");
    std::fs::create_dir_all(&package_a).unwrap();
    std::fs::create_dir_all(&package_b).unwrap();

    let root_string = path_string(root);
    let project_java = installation("jdk-25", SdkKind::Java, "25.0.2", "/sdk/jdk-25");
    let registry = SdkRegistry {
        installations: vec![project_java.clone()],
        ..SdkRegistry::default()
    };
    let resolution = resolution(
        &root_string,
        &root_string,
        vec![resolved(
            &root_string,
            SdkKind::Java,
            SdkRole::Project,
            project_java,
        )],
    );

    let first = build_workspace_environment(&resolution, &registry, &package_a);
    let second = build_workspace_environment(&resolution, &registry, &package_b);

    assert_ne!(first.scope_path, second.scope_path);
    assert_eq!(first.project_scope_path, second.project_scope_path);
    assert_eq!(first.fingerprint, second.fingerprint);
}

#[test]
fn passthrough_fingerprint_is_stable_across_workspace_directories() {
    let root = Path::new("/repo/project");
    let first = WorkspaceSdkEnvironment::passthrough(root, Path::new("/repo/project/pkg/a"));
    let second = WorkspaceSdkEnvironment::passthrough(root, Path::new("/repo/project/pkg/b"));

    assert_ne!(first.scope_path, second.scope_path);
    assert_eq!(first.fingerprint, second.fingerprint);
}
