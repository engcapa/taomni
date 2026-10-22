use super::builder::ProfileBuilder;
use super::files::directory_has_extension;
use super::files::first_capture;
use super::files::read_text;
use super::model::KotlinCompilerMode;
use super::model::KotlinPlatform;
use super::model::KotlinProjectProfile;
use super::model::ProjectBuildSystem;
use super::model::SdkConfidence;
use super::model::SdkConstraintPolicy;
use super::requirements::constraint;
use super::requirements::evidence;
use super::requirements::requirement;
use crate::sdk::SdkKind;
use crate::sdk::SdkRole;
use regex::Regex;
use std::path::Path;
use std::path::PathBuf;

pub(super) fn detect_gradle(
    workspace_root: &Path,
    scope: &Path,
    builder: &mut ProfileBuilder,
    warnings: &mut Vec<String>,
) {
    builder.add_build_system(ProjectBuildSystem::Gradle);
    let mut contents = String::new();
    let mut evidence_path = scope.join("build.gradle.kts");
    for name in [
        "settings.gradle.kts",
        "settings.gradle",
        "build.gradle.kts",
        "build.gradle",
    ] {
        let path = scope.join(name);
        if let Some(text) = read_text(&path, warnings) {
            if name.starts_with("build.") {
                evidence_path = path.clone();
            }
            contents.push_str(&text);
            contents.push('\n');
        }
    }

    let catalog = find_version_catalog(workspace_root, scope)
        .and_then(|path| read_text(&path, warnings).map(|text| (path, text)));
    let (catalog_kotlin_id, catalog_kotlin_version) = catalog
        .as_ref()
        .map(|(_, text)| kotlin_plugin_from_catalog(&contents, text))
        .unwrap_or((None, None));
    let kotlin_version = first_capture(
        &contents,
        &[
            r#"kotlin\s*\(\s*[\"'](?:jvm|android|multiplatform|js|wasm|native)[\"']\s*\)\s*version\s*[\"']([^\"']+)[\"']"#,
            r#"id\s*\(?\s*[\"']org\.jetbrains\.kotlin\.[^\"']+[\"']\s*\)?\s*version\s*[\"']([^\"']+)[\"']"#,
        ],
    )
    .or(catalog_kotlin_version);
    let has_kotlin = kotlin_version.is_some()
        || catalog_kotlin_id.is_some()
        || gradle_applies_kotlin_plugin(&contents)
        || directory_has_extension(scope, &["kt", "kts"]);
    let platform = if contents.contains("org.jetbrains.kotlin.multiplatform")
        || contents.contains("kotlin(\"multiplatform\")")
        || contents.contains("kotlin('multiplatform')")
        || catalog_kotlin_id.as_deref() == Some("org.jetbrains.kotlin.multiplatform")
    {
        KotlinPlatform::Multiplatform
    } else if contents.contains("org.jetbrains.kotlin.android")
        || contents.contains("com.android.application")
        || contents.contains("com.android.library")
        || catalog_kotlin_id.as_deref() == Some("org.jetbrains.kotlin.android")
    {
        KotlinPlatform::Android
    } else if contents.contains("org.jetbrains.kotlin.js")
        || contents.contains("kotlin(\"js\")")
        || contents.contains("kotlin('js')")
        || catalog_kotlin_id.as_deref() == Some("org.jetbrains.kotlin.js")
    {
        KotlinPlatform::Js
    } else if contents.contains("org.jetbrains.kotlin.wasm")
        || contents.contains("kotlin(\"wasm\")")
        || contents.contains("kotlin('wasm')")
        || catalog_kotlin_id
            .as_deref()
            .is_some_and(|id| id.starts_with("org.jetbrains.kotlin.wasm"))
    {
        KotlinPlatform::Wasm
    } else if contents.contains("org.jetbrains.kotlin.native")
        || contents.contains("kotlin(\"native\")")
        || contents.contains("kotlin('native')")
        || catalog_kotlin_id.as_deref() == Some("org.jetbrains.kotlin.native")
    {
        KotlinPlatform::Native
    } else if has_kotlin {
        KotlinPlatform::Jvm
    } else {
        KotlinPlatform::Unknown
    };
    let toolchain = first_capture(
        &contents,
        &[
            r"jvmToolchain\s*\(\s*([0-9]+)\s*\)",
            r"JavaLanguageVersion\.of\s*\(\s*([0-9]+)\s*\)",
            r"languageVersion\s*(?:=|\.set\s*\()\s*JavaLanguageVersion\.of\s*\(\s*([0-9]+)",
        ],
    );
    let source_compatibility = first_capture(
        &contents,
        &[
            r"sourceCompatibility\s*=\s*JavaVersion\.VERSION_([0-9_]+)",
            r#"sourceCompatibility\s*=\s*[\"']([^\"']+)[\"']"#,
        ],
    )
    .map(|value| value.replace('_', "."));
    let jvm_target = first_capture(
        &contents,
        &[
            r#"jvmTarget\s*(?:=|\.set\s*\()\s*[\"']([^\"']+)[\"']"#,
            r"jvmTarget\s*(?:=|\.set\s*\()\s*JvmTarget\.JVM_([0-9_]+)",
        ],
    )
    .map(|value| value.replace('_', "."));
    let language_version = first_capture(
        &contents,
        &[
            r#"languageVersion\s*(?:=|\.set\s*\()\s*[\"']([^\"']+)[\"']"#,
            r"languageVersion\s*(?:=|\.set\s*\()\s*KotlinVersion\.KOTLIN_([0-9_]+)",
        ],
    )
    .map(|value| value.replace('_', "."));
    let api_version = first_capture(
        &contents,
        &[
            r#"apiVersion\s*(?:=|\.set\s*\()\s*[\"']([^\"']+)[\"']"#,
            r"apiVersion\s*(?:=|\.set\s*\()\s*KotlinVersion\.KOTLIN_([0-9_]+)",
        ],
    )
    .map(|value| value.replace('_', "."));

    let launcher_home = read_gradle_property(scope, "org.gradle.java.home", warnings)
        .or_else(|| read_gradle_property(workspace_root, "org.gradle.java.home", warnings));
    let kotlin_needs_java = matches!(platform, KotlinPlatform::Jvm | KotlinPlatform::Android)
        || (platform == KotlinPlatform::Multiplatform
            && Regex::new(r"(?m)\bjvm\s*\(")
                .ok()
                .is_some_and(|pattern| pattern.is_match(&contents)));
    let has_scala =
        gradle_applies_scala_plugin(&contents) || directory_has_extension(scope, &["scala"]);
    let has_java = gradle_applies_java_plugin(&contents)
        || toolchain.is_some()
        || source_compatibility.is_some()
        || directory_has_extension(scope, &["java"])
        || kotlin_needs_java
        || has_scala;
    if has_java {
        builder.add_language(SdkKind::Java);
        let selected_version = toolchain.as_deref().or(source_compatibility.as_deref());
        builder.add_requirement(
            if toolchain.is_some() { 95 } else { 50 },
            requirement(
                SdkKind::Java,
                SdkRole::Project,
                selected_version.map(|value| {
                    constraint(
                        value,
                        if toolchain.is_some() {
                            SdkConstraintPolicy::ExactMajor
                        } else {
                            SdkConstraintPolicy::PreferredMajor
                        },
                    )
                }),
                None,
                false,
                "Gradle Java toolchain",
                if selected_version.is_some() {
                    SdkConfidence::High
                } else {
                    SdkConfidence::Low
                },
                evidence(
                    &evidence_path,
                    if toolchain.is_some() {
                        "javaToolchain"
                    } else {
                        "sourceCompatibility"
                    },
                    selected_version.unwrap_or("default JDK"),
                    if toolchain.is_some() {
                        SdkConfidence::High
                    } else {
                        SdkConfidence::Medium
                    },
                ),
            ),
        );
    }
    if let Some(location) = launcher_home.as_ref() {
        builder.add_requirement(
            100,
            requirement(
                SdkKind::Java,
                SdkRole::Launcher,
                None,
                Some(location.clone()),
                false,
                "org.gradle.java.home",
                SdkConfidence::High,
                evidence(
                    &scope.join("gradle.properties"),
                    "org.gradle.java.home",
                    location,
                    SdkConfidence::High,
                ),
            ),
        );
    }
    if has_kotlin {
        builder.add_language(SdkKind::Kotlin);
        builder.add_requirement(
            90,
            requirement(
                SdkKind::Kotlin,
                SdkRole::Compiler,
                kotlin_version
                    .as_deref()
                    .map(|value| constraint(value, SdkConstraintPolicy::Exact)),
                None,
                true,
                "Kotlin Gradle plugin",
                if kotlin_version.is_some() {
                    SdkConfidence::High
                } else {
                    SdkConfidence::Medium
                },
                evidence(
                    &evidence_path,
                    "kotlin.plugin.version",
                    kotlin_version.as_deref().unwrap_or("build-managed"),
                    SdkConfidence::High,
                ),
            ),
        );
        builder.kotlin = Some(KotlinProjectProfile {
            platform,
            compiler_mode: KotlinCompilerMode::BuildManaged,
            compiler_version: kotlin_version,
            language_version,
            api_version,
            jvm_target,
            java_toolchain: toolchain,
            gradle_launcher_java_home: launcher_home,
        });
    }
    if has_scala {
        builder.add_language(SdkKind::Scala);
        let scala_version = first_capture(
            &contents,
            &[r#"scala-library[:\"']+([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+)"#],
        );
        builder.add_requirement(
            80,
            requirement(
                SdkKind::Scala,
                SdkRole::Compiler,
                scala_version
                    .as_deref()
                    .map(|value| constraint(value, SdkConstraintPolicy::Exact)),
                None,
                true,
                "Gradle Scala plugin",
                SdkConfidence::Medium,
                evidence(
                    &evidence_path,
                    "scala-library",
                    scala_version.as_deref().unwrap_or("build-managed"),
                    SdkConfidence::Medium,
                ),
            ),
        );
    }
}

pub(super) fn find_version_catalog(workspace_root: &Path, scope: &Path) -> Option<PathBuf> {
    let local = scope.join("gradle/libs.versions.toml");
    if local.is_file() {
        Some(local)
    } else {
        let root = workspace_root.join("gradle/libs.versions.toml");
        root.is_file().then_some(root)
    }
}

pub(super) fn kotlin_plugin_from_catalog(
    build_contents: &str,
    catalog_contents: &str,
) -> (Option<String>, Option<String>) {
    let Some(value) = toml::from_str::<toml::Value>(catalog_contents).ok() else {
        return (None, None);
    };
    let versions = value.get("versions").and_then(toml::Value::as_table);
    let Some(plugins) = value.get("plugins").and_then(toml::Value::as_table) else {
        return (None, None);
    };
    for (alias, plugin) in plugins {
        let accessor = alias.replace(['-', '_'], ".");
        if !build_contents.contains(&format!("libs.plugins.{accessor}")) {
            continue;
        }
        if let Some(shorthand) = plugin.as_str() {
            let Some((id, version)) = shorthand.split_once(':') else {
                continue;
            };
            if id.starts_with("org.jetbrains.kotlin") {
                return (
                    Some(id.to_string()),
                    (!version.is_empty()).then(|| version.to_string()),
                );
            }
            continue;
        }
        let Some(table) = plugin.as_table() else {
            continue;
        };
        let id = table
            .get("id")
            .and_then(toml::Value::as_str)
            .unwrap_or_default();
        if !id.starts_with("org.jetbrains.kotlin") {
            continue;
        }
        if let Some(version) = table.get("version").and_then(toml::Value::as_str) {
            return (Some(id.to_string()), Some(version.to_string()));
        }
        let reference = table
            .get("version")
            .and_then(toml::Value::as_table)
            .and_then(|version| version.get("ref"))
            .and_then(toml::Value::as_str)
            .or_else(|| table.get("version.ref").and_then(toml::Value::as_str));
        let version = reference
            .and_then(|reference| versions.and_then(|versions| versions.get(reference)))
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        return (Some(id.to_string()), version);
    }
    (None, None)
}

pub(super) fn gradle_applies_kotlin_plugin(contents: &str) -> bool {
    Regex::new(
        r#"(?m)(?:id\s*\(?\s*[\"']org\.jetbrains\.kotlin\.[^\"']+[\"']|kotlin\s*\(\s*[\"'](?:jvm|android|multiplatform|js|wasm|native)[\"']\s*\))"#,
    )
    .ok()
    .is_some_and(|pattern| pattern.is_match(contents))
}

pub(super) fn gradle_applies_java_plugin(contents: &str) -> bool {
    Regex::new(
        r#"(?ms)(?:id\s*\(?\s*[\"'](?:java|java-library|application)[\"']|plugins\s*\{[^}]*\b(?:java|javaLibrary|application)\b|\bjava\s*\{)"#,
    )
    .ok()
    .is_some_and(|pattern| pattern.is_match(contents))
}

pub(super) fn gradle_applies_scala_plugin(contents: &str) -> bool {
    Regex::new(r#"(?ms)(?:id\s*\(?\s*[\"']scala[\"']|plugins\s*\{[^}]*\bscala\b|scala-library)"#)
        .ok()
        .is_some_and(|pattern| pattern.is_match(contents))
}

pub(super) fn read_gradle_property(
    scope: &Path,
    key: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let path = scope.join("gradle.properties");
    let contents = read_text(&path, warnings)?;
    contents.lines().find_map(|line| {
        let (candidate, value) = line.split_once('=')?;
        (candidate.trim() == key).then(|| value.trim().to_string())
    })
}
