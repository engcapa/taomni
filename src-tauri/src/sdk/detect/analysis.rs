use super::builder::ProfileBuilder;
use super::files::canonical_or_original;
use super::files::path_string;
use super::gradle::detect_gradle;
use super::maven::detect_maven;
use super::model::WorkspaceSdkAnalysis;
use super::python::detect_python;
use super::scopes::collect_scope_directories;
use super::scopes::has_gradle_marker;
use super::scopes::has_python_marker;
use super::standalone::detect_sbt;
use super::standalone::detect_standalone_sources;
use super::version_files::detect_shared_version_files;
use std::path::PathBuf;

pub fn analyze_workspace(workspace_root: &str) -> Result<WorkspaceSdkAnalysis, String> {
    let requested = PathBuf::from(shellexpand::tilde(workspace_root.trim()).to_string());
    if workspace_root.trim().is_empty() {
        return Err("Workspace root is required".to_string());
    }
    if !requested.is_dir() {
        return Err(format!(
            "Workspace root is not a directory: {}",
            requested.display()
        ));
    }
    let root = canonical_or_original(&requested);
    let scope_dirs = collect_scope_directories(&root);
    let mut warnings = Vec::new();
    let mut profiles = Vec::new();

    for scope in scope_dirs {
        let mut builder = ProfileBuilder::new(&root, &scope);
        detect_shared_version_files(&scope, &mut builder, &mut warnings);
        if scope.join("pom.xml").is_file() {
            detect_maven(&scope, &mut builder, &mut warnings);
        }
        if has_gradle_marker(&scope) {
            detect_gradle(&root, &scope, &mut builder, &mut warnings);
        }
        if scope.join("build.sbt").is_file() {
            detect_sbt(&scope, &mut builder, &mut warnings);
        }
        if has_python_marker(&scope) {
            detect_python(&scope, &mut builder, &mut warnings);
        }
        if builder.build_systems.is_empty() {
            detect_standalone_sources(&scope, &mut builder);
        }
        if !builder.languages.is_empty() || !builder.requirements.is_empty() {
            profiles.push(builder.finish());
        }
    }

    if profiles.is_empty() {
        let mut builder = ProfileBuilder::new(&root, &root);
        detect_standalone_sources(&root, &mut builder);
        if !builder.languages.is_empty() {
            profiles.push(builder.finish());
        }
    }
    profiles.sort_by(|left, right| left.scope_path.cmp(&right.scope_path));
    Ok(WorkspaceSdkAnalysis {
        workspace_root: path_string(&root),
        profiles,
        warnings,
    })
}
