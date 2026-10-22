use super::builder::ProfileBuilder;
use super::files::read_text;
use super::files::read_trimmed;
use super::model::SdkConfidence;
use super::model::SdkConstraintPolicy;
use super::requirements::constraint;
use super::requirements::evidence;
use super::requirements::requirement;
use crate::sdk::SdkKind;
use crate::sdk::SdkRole;
use std::path::Path;

pub(super) fn detect_shared_version_files(
    scope: &Path,
    builder: &mut ProfileBuilder,
    warnings: &mut Vec<String>,
) {
    for (file_name, kind) in [
        (".java-version", SdkKind::Java),
        (".python-version", SdkKind::Python),
        (".scala-version", SdkKind::Scala),
        (".kotlin-version", SdkKind::Kotlin),
    ] {
        let path = scope.join(file_name);
        let Some(value) = read_trimmed(&path, warnings) else {
            continue;
        };
        builder.add_language(kind);
        builder.add_requirement(
            85,
            requirement(
                kind,
                if matches!(kind, SdkKind::Kotlin | SdkKind::Scala) {
                    SdkRole::Compiler
                } else {
                    SdkRole::Project
                },
                Some(constraint(&value, SdkConstraintPolicy::Exact)),
                None,
                false,
                file_name,
                SdkConfidence::High,
                evidence(&path, file_name, &value, SdkConfidence::High),
            ),
        );
    }

    let sdkman = scope.join(".sdkmanrc");
    if let Some(contents) = read_text(&sdkman, warnings) {
        for line in contents.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let (kind, role) = match key.trim() {
                "java" => (SdkKind::Java, SdkRole::Project),
                "kotlin" => (SdkKind::Kotlin, SdkRole::Compiler),
                "scala" => (SdkKind::Scala, SdkRole::Compiler),
                _ => continue,
            };
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            builder.add_language(kind);
            builder.add_requirement(
                80,
                requirement(
                    kind,
                    role,
                    Some(constraint(value, SdkConstraintPolicy::PreferredMajor)),
                    None,
                    false,
                    ".sdkmanrc",
                    SdkConfidence::High,
                    evidence(&sdkman, key.trim(), value, SdkConfidence::High),
                ),
            );
        }
    }

    let asdf = scope.join(".tool-versions");
    if let Some(contents) = read_text(&asdf, warnings) {
        for line in contents.lines() {
            let mut parts = line.split_whitespace();
            let Some(tool) = parts.next() else {
                continue;
            };
            let Some(value) = parts.next() else {
                continue;
            };
            let (kind, role) = match tool {
                "java" => (SdkKind::Java, SdkRole::Project),
                "python" => (SdkKind::Python, SdkRole::Project),
                "kotlin" => (SdkKind::Kotlin, SdkRole::Compiler),
                "scala" => (SdkKind::Scala, SdkRole::Compiler),
                _ => continue,
            };
            builder.add_language(kind);
            builder.add_requirement(
                80,
                requirement(
                    kind,
                    role,
                    Some(constraint(value, SdkConstraintPolicy::Exact)),
                    None,
                    false,
                    ".tool-versions",
                    SdkConfidence::High,
                    evidence(&asdf, tool, value, SdkConfidence::High),
                ),
            );
        }
    }
}
