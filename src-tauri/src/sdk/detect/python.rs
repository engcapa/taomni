use super::builder::ProfileBuilder;
use super::files::canonical_or_original;
use super::files::path_string;
use super::files::read_text;
use super::files::read_trimmed;
use super::model::ProjectBuildSystem;
use super::model::SdkConfidence;
use super::model::SdkConstraintPolicy;
use super::requirements::constraint;
use super::requirements::evidence;
use super::requirements::requirement;
use crate::sdk::SdkKind;
use crate::sdk::SdkRole;
use std::path::Path;

pub(super) fn detect_python(
    scope: &Path,
    builder: &mut ProfileBuilder,
    warnings: &mut Vec<String>,
) {
    builder.add_language(SdkKind::Python);
    let mut version = None;
    let mut version_source = None;
    let pyproject_path = scope.join("pyproject.toml");
    if let Some(contents) = read_text(&pyproject_path, warnings) {
        builder.add_build_system(ProjectBuildSystem::Pyproject);
        match toml::from_str::<toml::Value>(&contents) {
            Ok(project) => {
                version = project
                    .get("project")
                    .and_then(|value| value.get("requires-python"))
                    .and_then(toml::Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        project
                            .get("tool")
                            .and_then(|value| value.get("poetry"))
                            .and_then(|value| value.get("dependencies"))
                            .and_then(|value| value.get("python"))
                            .and_then(toml::Value::as_str)
                            .map(str::to_string)
                    });
                if version.is_some() {
                    version_source = Some(pyproject_path.clone());
                }
            }
            Err(error) => warnings.push(format!("parse {}: {error}", pyproject_path.display())),
        }
    }
    let python_version_path = scope.join(".python-version");
    if let Some(exact) = read_trimmed(&python_version_path, warnings) {
        version = exact.split_whitespace().next().map(str::to_string);
        version_source = Some(python_version_path);
    }
    let pipfile_path = scope.join("Pipfile");
    if version.is_none() {
        if let Some(contents) = read_text(&pipfile_path, warnings) {
            if let Ok(value) = toml::from_str::<toml::Value>(&contents) {
                version = value
                    .get("requires")
                    .and_then(|requires| requires.get("python_full_version"))
                    .or_else(|| {
                        value
                            .get("requires")
                            .and_then(|requires| requires.get("python_version"))
                    })
                    .and_then(toml::Value::as_str)
                    .map(str::to_string);
                if version.is_some() {
                    version_source = Some(pipfile_path.clone());
                }
            }
        }
    }
    let runtime_path = scope.join("runtime.txt");
    if version.is_none() {
        if let Some(runtime) = read_trimmed(&runtime_path, warnings) {
            version = Some(runtime.trim_start_matches("python-").to_string());
            version_source = Some(runtime_path);
        }
    }
    let local_environment = [scope.join(".venv"), scope.join("venv")]
        .into_iter()
        .find(|path| path.is_dir())
        .map(|path| path_string(&canonical_or_original(&path)));
    let policy = version
        .as_deref()
        .map(|value| {
            if value.starts_with(">=")
                && !value.contains(',')
                && !value[2..].contains(['<', '>', '=', '~', '^', '*'])
            {
                SdkConstraintPolicy::Minimum
            } else if value.contains(['<', '>', '=', '~', '^', '*', ',']) {
                SdkConstraintPolicy::Range
            } else {
                SdkConstraintPolicy::Exact
            }
        })
        .unwrap_or(SdkConstraintPolicy::Any);
    let source_path = version_source.unwrap_or_else(|| pyproject_path.clone());
    builder.add_requirement(
        if local_environment.is_some() { 100 } else { 75 },
        requirement(
            SdkKind::Python,
            SdkRole::Project,
            version.as_deref().map(|value| constraint(value, policy)),
            local_environment,
            false,
            "Python project",
            if version.is_some() {
                SdkConfidence::High
            } else {
                SdkConfidence::Low
            },
            evidence(
                &source_path,
                "requires-python",
                version.as_deref().unwrap_or("default Python"),
                SdkConfidence::High,
            ),
        ),
    );
}
