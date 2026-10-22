use super::builder::ProfileBuilder;
use super::files::MAX_STANDALONE_FILES;
use super::files::first_capture;
use super::files::path_string;
use super::files::read_text;
use super::model::KotlinCompilerMode;
use super::model::KotlinPlatform;
use super::model::KotlinProjectProfile;
use super::model::ProjectBuildSystem;
use super::model::SdkConfidence;
use super::model::SdkConstraintPolicy;
use super::model::SdkEvidence;
use super::requirements::constraint;
use super::requirements::evidence;
use super::requirements::requirement;
use super::scopes::has_scope_marker;
use super::scopes::should_skip_directory;
use crate::sdk::SdkKind;
use crate::sdk::SdkRole;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::path::Path;

pub(super) fn detect_sbt(scope: &Path, builder: &mut ProfileBuilder, warnings: &mut Vec<String>) {
    let path = scope.join("build.sbt");
    let Some(contents) = read_text(&path, warnings) else {
        return;
    };
    builder.add_build_system(ProjectBuildSystem::Sbt);
    builder.add_language(SdkKind::Scala);
    builder.add_language(SdkKind::Java);
    let scala_version = first_capture(
        &contents,
        &[r#"(?:ThisBuild\s*/\s*)?scalaVersion\s*:?=\s*[\"']([^\"']+)[\"']"#],
    );
    builder.add_requirement(
        90,
        requirement(
            SdkKind::Scala,
            SdkRole::Compiler,
            scala_version
                .as_deref()
                .map(|value| constraint(value, SdkConstraintPolicy::Exact)),
            None,
            true,
            "sbt",
            if scala_version.is_some() {
                SdkConfidence::High
            } else {
                SdkConfidence::Medium
            },
            evidence(
                &path,
                "scalaVersion",
                scala_version.as_deref().unwrap_or("build-managed"),
                SdkConfidence::High,
            ),
        ),
    );
    let release = first_capture(
        &contents,
        &[
            r#"[\"']--release[\"']\s*,\s*[\"']([0-9]+)[\"']"#,
            r#"[\"']-target:(?:jvm-)?([0-9]+(?:\.[0-9]+)?)[\"']"#,
        ],
    );
    let java_home = first_capture(
        &contents,
        &[r#"javaHome\s*:?=\s*Some\s*\(\s*file\s*\(\s*[\"']([^\"']+)[\"']"#],
    )
    .map(|value| scope.join(value).to_string_lossy().into_owned());
    builder.add_requirement(
        if java_home.is_some() { 100 } else { 65 },
        requirement(
            SdkKind::Java,
            SdkRole::Project,
            release
                .as_deref()
                .map(|value| constraint(value, SdkConstraintPolicy::PreferredMajor)),
            java_home,
            false,
            "sbt JVM",
            if release.is_some() {
                SdkConfidence::High
            } else {
                SdkConfidence::Low
            },
            evidence(
                &path,
                "JVM target",
                release.as_deref().unwrap_or("default JDK"),
                SdkConfidence::Medium,
            ),
        ),
    );
}

pub(super) fn detect_standalone_sources(scope: &Path, builder: &mut ProfileBuilder) {
    let mut extensions = HashSet::new();
    let mut queue = VecDeque::from([(scope.to_path_buf(), 0_usize)]);
    let mut inspected = 0_usize;
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 3 || inspected >= MAX_STANDALONE_FILES {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && !should_skip_directory(&path) && !has_scope_marker(&path) {
                queue.push_back((path, depth + 1));
            } else if path.is_file() {
                inspected += 1;
                if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
                    extensions.insert(extension.to_ascii_lowercase());
                }
            }
            if inspected >= MAX_STANDALONE_FILES {
                break;
            }
        }
    }

    for (kind, role, extensions_for_kind) in [
        (SdkKind::Java, SdkRole::Project, &["java"][..]),
        (SdkKind::Kotlin, SdkRole::Compiler, &["kt", "kts"][..]),
        (SdkKind::Scala, SdkRole::Compiler, &["scala", "sc"][..]),
        (SdkKind::Python, SdkRole::Project, &["py"][..]),
    ] {
        if !extensions_for_kind
            .iter()
            .any(|extension| extensions.contains(*extension))
        {
            continue;
        }
        builder.add_language(kind);
        builder.add_build_system(ProjectBuildSystem::Standalone);
        builder.add_requirement(
            10,
            requirement(
                kind,
                role,
                None,
                None,
                false,
                "standalone sources",
                SdkConfidence::Low,
                SdkEvidence {
                    source_path: path_string(scope),
                    key: "source extension".to_string(),
                    value: extensions_for_kind.join(","),
                    confidence: SdkConfidence::Low,
                },
            ),
        );
        if kind == SdkKind::Kotlin && builder.kotlin.is_none() {
            builder.kotlin = Some(KotlinProjectProfile {
                platform: KotlinPlatform::Jvm,
                compiler_mode: KotlinCompilerMode::Standalone,
                compiler_version: None,
                language_version: None,
                api_version: None,
                jvm_target: None,
                java_toolchain: None,
                gradle_launcher_java_home: None,
            });
            builder.add_requirement(
                10,
                requirement(
                    SdkKind::Java,
                    SdkRole::Project,
                    None,
                    None,
                    false,
                    "Kotlin/JVM runtime",
                    SdkConfidence::Low,
                    SdkEvidence {
                        source_path: path_string(scope),
                        key: "platform".to_string(),
                        value: "JVM".to_string(),
                        confidence: SdkConfidence::Low,
                    },
                ),
            );
        }
    }
}
