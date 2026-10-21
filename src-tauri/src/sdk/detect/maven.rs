use super::builder::ProfileBuilder;
use super::files::directory_has_extension;
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
use std::collections::HashMap;
use std::path::Path;

pub(super) fn detect_maven(scope: &Path, builder: &mut ProfileBuilder, warnings: &mut Vec<String>) {
    let path = scope.join("pom.xml");
    let Some(contents) = read_text(&path, warnings) else {
        return;
    };
    builder.add_build_system(ProjectBuildSystem::Maven);
    let properties = maven_properties(&contents);

    let has_kotlin =
        contents.contains("kotlin-maven-plugin") || directory_has_extension(scope, &["kt", "kts"]);
    let kotlin_plugin_version = has_kotlin
        .then(|| {
            maven_plugin_version(&contents, "kotlin-maven-plugin", &properties)
                .or_else(|| property_value(&properties, "kotlin.version"))
        })
        .flatten();
    if has_kotlin {
        builder.add_language(SdkKind::Kotlin);
        let version = kotlin_plugin_version.clone();
        builder.add_requirement(
            90,
            requirement(
                SdkKind::Kotlin,
                SdkRole::Compiler,
                version
                    .as_deref()
                    .map(|value| constraint(value, SdkConstraintPolicy::Exact)),
                None,
                true,
                "kotlin-maven-plugin",
                if version.is_some() {
                    SdkConfidence::High
                } else {
                    SdkConfidence::Medium
                },
                evidence(
                    &path,
                    "kotlin-maven-plugin.version",
                    version.as_deref().unwrap_or("build-managed"),
                    SdkConfidence::High,
                ),
            ),
        );
        let language_version = maven_value(
            &contents,
            &properties,
            &["kotlin.compiler.languageVersion", "languageVersion"],
        );
        let api_version = maven_value(
            &contents,
            &properties,
            &["kotlin.compiler.apiVersion", "apiVersion"],
        );
        let jvm_target = maven_value(
            &contents,
            &properties,
            &["kotlin.compiler.jvmTarget", "jvmTarget"],
        );
        builder.kotlin = Some(KotlinProjectProfile {
            platform: KotlinPlatform::Jvm,
            compiler_mode: KotlinCompilerMode::BuildManaged,
            compiler_version: version,
            language_version,
            api_version,
            jvm_target,
            java_toolchain: None,
            gradle_launcher_java_home: None,
        });
    }

    let has_scala =
        contents.contains("scala-maven-plugin") || directory_has_extension(scope, &["scala"]);
    let scala_version = has_scala
        .then(|| {
            property_value(&properties, "scala.version")
                .or_else(|| maven_plugin_version(&contents, "scala-maven-plugin", &properties))
        })
        .flatten();
    if has_scala {
        builder.add_language(SdkKind::Scala);
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
                "scala-maven-plugin",
                SdkConfidence::High,
                evidence(
                    &path,
                    "scala.version",
                    scala_version.as_deref().unwrap_or("build-managed"),
                    SdkConfidence::High,
                ),
            ),
        );
    }

    let java_source = directory_has_extension(scope, &["java"])
        || contents.contains("maven-compiler-plugin")
        || properties.keys().any(|key| {
            matches!(
                key.as_str(),
                "java.version"
                    | "maven.compiler.release"
                    | "maven.compiler.source"
                    | "maven.compiler.target"
            )
        });
    if java_source {
        builder.add_language(SdkKind::Java);
    }

    let jdk_home = maven_value(
        &contents,
        &properties,
        &["kotlin.compiler.jdkHome", "jdkHome"],
    );
    let jdk_toolchain = xml_block_tag_value(&contents, "jdkToolchain", "version")
        .map(|value| resolve_maven_value(&value, &properties));
    let jdk_release = maven_value(
        &contents,
        &properties,
        &[
            "kotlin.compiler.jdkRelease",
            "maven.compiler.release",
            "release",
            "java.version",
            "maven.compiler.target",
            "target",
            "maven.compiler.source",
            "source",
        ],
    );
    if java_source || has_kotlin || has_scala {
        let selected_version = jdk_toolchain.as_deref().or(jdk_release.as_deref());
        builder.add_requirement(
            if jdk_home.is_some() {
                100
            } else if jdk_toolchain.is_some() {
                95
            } else {
                70
            },
            requirement(
                SdkKind::Java,
                SdkRole::Project,
                selected_version.map(|value| {
                    constraint(
                        value,
                        if jdk_toolchain.is_some() {
                            SdkConstraintPolicy::ExactMajor
                        } else {
                            SdkConstraintPolicy::PreferredMajor
                        },
                    )
                }),
                jdk_home.clone(),
                false,
                "pom.xml",
                if jdk_home.is_some() || jdk_release.is_some() {
                    SdkConfidence::High
                } else {
                    SdkConfidence::Low
                },
                evidence(
                    &path,
                    if jdk_home.is_some() {
                        "kotlin.compiler.jdkHome"
                    } else if jdk_toolchain.is_some() {
                        "jdkToolchain.version"
                    } else {
                        "maven.compiler.release"
                    },
                    jdk_home
                        .as_deref()
                        .or(selected_version)
                        .unwrap_or("default JDK"),
                    SdkConfidence::High,
                ),
            ),
        );
        if let Some(kotlin) = builder.kotlin.as_mut() {
            kotlin.java_toolchain = selected_version.map(str::to_string);
        }
    }
}

pub(super) fn maven_properties(contents: &str) -> HashMap<String, String> {
    let mut properties = HashMap::new();
    let Ok(block_pattern) = Regex::new(r"(?s)<properties(?:\s[^>]*)?>(.*?)</properties>") else {
        return properties;
    };
    let Ok(value_pattern) = Regex::new(
        r"(?s)<([A-Za-z_][A-Za-z0-9_.-]*)(?:\s[^>]*)?>\s*([^<]+?)\s*</[A-Za-z_][A-Za-z0-9_.-]*>",
    ) else {
        return properties;
    };
    let Some(block) = block_pattern
        .captures(contents)
        .and_then(|captures| captures.get(1))
    else {
        return properties;
    };
    for captures in value_pattern.captures_iter(block.as_str()) {
        let Some(key) = captures.get(1) else {
            continue;
        };
        let Some(value) = captures.get(2) else {
            continue;
        };
        properties.insert(key.as_str().to_string(), value.as_str().trim().to_string());
    }
    properties
}

pub(super) fn maven_value(
    contents: &str,
    properties: &HashMap<String, String>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(value) = property_value(properties, key) {
            return Some(resolve_maven_value(&value, properties));
        }
        if let Some(value) = xml_tag_value(contents, key) {
            return Some(resolve_maven_value(&value, properties));
        }
    }
    None
}

pub(super) fn maven_plugin_version(
    contents: &str,
    artifact_id: &str,
    properties: &HashMap<String, String>,
) -> Option<String> {
    let pattern = Regex::new(&format!(
        r"(?s)<plugin(?:\s[^>]*)?>.*?<artifactId>\s*{}\s*</artifactId>.*?<version>\s*([^<]+)\s*</version>.*?</plugin>",
        regex::escape(artifact_id)
    ))
    .ok()?;
    pattern
        .captures(contents)
        .and_then(|captures| captures.get(1))
        .map(|value| resolve_maven_value(value.as_str().trim(), properties))
}

pub(super) fn xml_tag_value(contents: &str, tag: &str) -> Option<String> {
    let pattern = Regex::new(&format!(
        r"(?s)<(?:[A-Za-z0-9_-]+:)?{}(?:\s[^>]*)?>\s*([^<]+?)\s*</(?:[A-Za-z0-9_-]+:)?{}>",
        regex::escape(tag),
        regex::escape(tag)
    ))
    .ok()?;
    pattern
        .captures(contents)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_string())
}

pub(super) fn xml_block_tag_value(contents: &str, block: &str, tag: &str) -> Option<String> {
    let pattern = Regex::new(&format!(
        r"(?s)<(?:[A-Za-z0-9_-]+:)?{}(?:\s[^>]*)?>(.*?)</(?:[A-Za-z0-9_-]+:)?{}>",
        regex::escape(block),
        regex::escape(block)
    ))
    .ok()?;
    let block = pattern
        .captures(contents)
        .and_then(|captures| captures.get(1))?;
    xml_tag_value(block.as_str(), tag)
}

pub(super) fn property_value(properties: &HashMap<String, String>, key: &str) -> Option<String> {
    properties.get(key).cloned()
}

pub(super) fn resolve_maven_value(value: &str, properties: &HashMap<String, String>) -> String {
    let Ok(pattern) = Regex::new(r"\$\{([^}]+)}") else {
        return value.to_string();
    };
    let mut resolved = value.to_string();
    for _ in 0..5 {
        let replaced = pattern
            .replace_all(&resolved, |captures: &regex::Captures<'_>| {
                properties
                    .get(
                        captures
                            .get(1)
                            .map(|value| value.as_str())
                            .unwrap_or_default(),
                    )
                    .cloned()
                    .unwrap_or_else(|| captures.get(0).unwrap().as_str().to_string())
            })
            .to_string();
        if replaced == resolved {
            break;
        }
        resolved = replaced;
    }
    resolved
}
