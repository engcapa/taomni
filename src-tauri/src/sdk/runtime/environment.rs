use super::fingerprint::fingerprint;
use super::java::java_runtime_configurations;
use super::model::WorkspaceSdkEnvironment;
use super::paths::canonical_or_original;
use super::paths::executable_directories;
use super::paths::is_python_environment;
use super::paths::normalize_inherited_home;
use super::paths::path_string;
use super::paths::sdk_home;
use super::selection::nearest_project_scope;
use super::selection::select_tooling_java;
use super::selection::selected_installation;
use crate::sdk::SdkKind;
use crate::sdk::SdkRegistry;
use crate::sdk::SdkRole;
use crate::sdk::resolve::WorkspaceSdkResolution;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

pub fn build_workspace_environment(
    resolution: &WorkspaceSdkResolution,
    registry: &SdkRegistry,
    requested_scope: &Path,
) -> WorkspaceSdkEnvironment {
    let workspace_root = PathBuf::from(&resolution.analysis.workspace_root);
    let requested_scope = canonical_or_original(requested_scope);
    let project_scope = nearest_project_scope(resolution, &requested_scope)
        .unwrap_or_else(|| workspace_root.clone());

    let project_java = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Java,
        SdkRole::Project,
    );
    let launcher_java = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Java,
        SdkRole::Launcher,
    )
    .or_else(|| project_java.clone());
    let python = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Python,
        SdkRole::Project,
    );
    let kotlin = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Kotlin,
        SdkRole::Compiler,
    );
    let scala = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Scala,
        SdkRole::Compiler,
    );
    let (tooling_java, tooling_java_error) = select_tooling_java(registry, &requested_scope);

    let mut environment = BTreeMap::new();
    // All home paths are normalized (verbatim prefix stripped) before they
    // become environment values so a legacy `\\?\C:\...` registry entry can't
    // poison JAVA_HOME/VIRTUAL_ENV for shells and batch launchers.
    let project_java_home = project_java.as_ref().map(sdk_home);
    let launcher_java_home = launcher_java.as_ref().map(sdk_home);
    if let Some(java_home) = launcher_java_home.as_ref().or(project_java_home.as_ref()) {
        environment.insert("JAVA_HOME".to_string(), java_home.clone());
    } else if let Some(java_home) = std::env::var("JAVA_HOME")
        .ok()
        .and_then(|value| normalize_inherited_home(&value))
    {
        // A hosted/GUI launch may have no registered project SDK yet. Keep
        // the process-level Java selection explicit so Maven/Gradle batch
        // launchers on Windows do not fall back to an older PATH JDK.
        environment.insert("JAVA_HOME".to_string(), java_home);
    }

    let python_home = python.as_ref().map(sdk_home);
    if let Some(sdk) = python.as_ref()
        && is_python_environment(&sdk.location)
    {
        environment.insert("VIRTUAL_ENV".to_string(), sdk_home(sdk));
    }
    let kotlin_home = kotlin.as_ref().map(sdk_home);
    if let Some(home) = kotlin_home.as_ref() {
        environment.insert("KOTLIN_HOME".to_string(), home.clone());
    }
    let scala_home = scala.as_ref().map(sdk_home);
    if let Some(home) = scala_home.as_ref() {
        environment.insert("SCALA_HOME".to_string(), home.clone());
    }

    let selected = [
        launcher_java.as_ref(),
        project_java.as_ref(),
        python.as_ref(),
        kotlin.as_ref(),
        scala.as_ref(),
    ];
    let path_entries = executable_directories(selected.into_iter().flatten());
    let java_runtimes = java_runtime_configurations(registry, project_java.as_ref());
    let tooling_java_home = tooling_java.as_ref().map(sdk_home);
    let workspace_root = path_string(&workspace_root);
    let scope_path = path_string(&requested_scope);
    let project_scope_path = path_string(&project_scope);

    // `scope_path` is the current file's parent directory. The selected SDKs
    // and nearest project scope below already capture every environment input;
    // including the request directory made otherwise-identical files in two
    // packages produce distinct LSP session keys and relaunch jdtls.
    let mut fingerprint_parts = vec![workspace_root.as_str(), project_scope_path.as_str()];
    for sdk in selected.into_iter().flatten() {
        fingerprint_parts.extend([
            sdk.id.as_str(),
            sdk.location.as_str(),
            sdk.version.as_deref().unwrap_or(""),
        ]);
    }
    if let Some(sdk) = tooling_java.as_ref() {
        fingerprint_parts.extend([
            sdk.id.as_str(),
            sdk.location.as_str(),
            sdk.version.as_deref().unwrap_or(""),
        ]);
    }
    if let Some(error) = tooling_java_error.as_deref() {
        fingerprint_parts.push(error);
    }
    for runtime in &java_runtimes {
        fingerprint_parts.extend([
            runtime.name.as_str(),
            runtime.path.as_str(),
            if runtime.default { "default" } else { "" },
        ]);
    }
    let fingerprint = fingerprint(&fingerprint_parts);

    WorkspaceSdkEnvironment {
        workspace_root,
        scope_path,
        project_scope_path,
        fingerprint,
        environment,
        path_entries,
        project_java_home,
        launcher_java_home,
        tooling_java_home,
        tooling_java_error,
        python_home,
        kotlin_home,
        scala_home,
        java_runtimes,
    }
}
