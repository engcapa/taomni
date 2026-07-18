use super::{SdkKind, SdkRole};
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

const MAX_SCAN_DEPTH: usize = 6;
const MAX_SCAN_DIRECTORIES: usize = 1_000;
const MAX_STANDALONE_FILES: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkConstraintPolicy {
    Any,
    Exact,
    ExactMajor,
    PreferredMajor,
    Minimum,
    Range,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkVersionConstraint {
    pub raw: String,
    pub policy: SdkConstraintPolicy,
    pub major: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkEvidence {
    pub source_path: String,
    pub key: String,
    pub value: String,
    pub confidence: SdkConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkRequirement {
    pub kind: SdkKind,
    pub role: SdkRole,
    pub constraint: Option<SdkVersionConstraint>,
    pub required_location: Option<String>,
    pub managed_by_build: bool,
    pub source: String,
    pub confidence: SdkConfidence,
    pub evidence: Vec<SdkEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectBuildSystem {
    Maven,
    Gradle,
    Sbt,
    Pyproject,
    Standalone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KotlinPlatform {
    Jvm,
    Android,
    Multiplatform,
    Js,
    Wasm,
    Native,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KotlinCompilerMode {
    BuildManaged,
    Standalone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KotlinProjectProfile {
    pub platform: KotlinPlatform,
    pub compiler_mode: KotlinCompilerMode,
    pub compiler_version: Option<String>,
    pub language_version: Option<String>,
    pub api_version: Option<String>,
    pub jvm_target: Option<String>,
    pub java_toolchain: Option<String>,
    pub gradle_launcher_java_home: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSdkProfile {
    pub scope_path: String,
    pub relative_path: String,
    pub display_name: String,
    pub build_systems: Vec<ProjectBuildSystem>,
    pub languages: Vec<SdkKind>,
    pub requirements: Vec<SdkRequirement>,
    pub kotlin: Option<KotlinProjectProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSdkAnalysis {
    pub workspace_root: String,
    pub profiles: Vec<ProjectSdkProfile>,
    pub warnings: Vec<String>,
}

struct RequirementCandidate {
    priority: u16,
    requirement: SdkRequirement,
}

struct ProfileBuilder {
    scope_path: PathBuf,
    relative_path: String,
    display_name: String,
    build_systems: Vec<ProjectBuildSystem>,
    languages: HashSet<SdkKind>,
    requirements: Vec<RequirementCandidate>,
    kotlin: Option<KotlinProjectProfile>,
}

impl ProfileBuilder {
    fn new(root: &Path, scope: &Path) -> Self {
        let relative_path = scope
            .strip_prefix(root)
            .ok()
            .filter(|relative| !relative.as_os_str().is_empty())
            .map(path_string)
            .unwrap_or_else(|| ".".to_string());
        let display_name = scope
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Workspace")
            .to_string();
        Self {
            scope_path: scope.to_path_buf(),
            relative_path,
            display_name,
            build_systems: Vec::new(),
            languages: HashSet::new(),
            requirements: Vec::new(),
            kotlin: None,
        }
    }

    fn add_build_system(&mut self, build_system: ProjectBuildSystem) {
        if !self.build_systems.contains(&build_system) {
            self.build_systems.push(build_system);
        }
    }

    fn add_language(&mut self, kind: SdkKind) {
        self.languages.insert(kind);
    }

    fn add_requirement(&mut self, priority: u16, mut requirement: SdkRequirement) {
        if let Some(existing) = self.requirements.iter_mut().find(|candidate| {
            candidate.requirement.kind == requirement.kind
                && candidate.requirement.role == requirement.role
                && candidate.requirement.managed_by_build == requirement.managed_by_build
        }) {
            if priority > existing.priority {
                requirement
                    .evidence
                    .extend(existing.requirement.evidence.clone());
                *existing = RequirementCandidate {
                    priority,
                    requirement,
                };
            } else {
                existing.requirement.evidence.extend(requirement.evidence);
            }
            return;
        }
        self.requirements.push(RequirementCandidate {
            priority,
            requirement,
        });
    }

    fn finish(mut self) -> ProjectSdkProfile {
        self.build_systems
            .sort_by_key(|system| format!("{system:?}"));
        let mut languages: Vec<_> = self.languages.into_iter().collect();
        languages.sort();
        let mut requirements: Vec<_> = self
            .requirements
            .into_iter()
            .map(|candidate| candidate.requirement)
            .collect();
        requirements.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| format!("{:?}", left.role).cmp(&format!("{:?}", right.role)))
        });
        ProjectSdkProfile {
            scope_path: path_string(&canonical_or_original(&self.scope_path)),
            relative_path: self.relative_path,
            display_name: self.display_name,
            build_systems: self.build_systems,
            languages,
            requirements,
            kotlin: self.kotlin,
        }
    }
}

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

fn collect_scope_directories(root: &Path) -> Vec<PathBuf> {
    let mut scopes = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    let mut visited = 0_usize;
    while let Some((directory, depth)) = queue.pop_front() {
        if visited >= MAX_SCAN_DIRECTORIES {
            break;
        }
        visited += 1;
        if has_scope_marker(&directory) {
            scopes.push(directory.clone());
        }
        if depth >= MAX_SCAN_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || should_skip_directory(&path) {
                continue;
            }
            queue.push_back((path, depth + 1));
        }
    }
    if scopes.is_empty() || !scopes.iter().any(|scope| paths_equal(scope, root)) {
        scopes.push(root.to_path_buf());
    }
    scopes.sort();
    scopes.dedup();
    scopes
}

fn has_scope_marker(directory: &Path) -> bool {
    [
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "build.sbt",
        "pyproject.toml",
        "Pipfile",
        ".java-version",
        ".python-version",
        ".scala-version",
        ".kotlin-version",
        ".sdkmanrc",
        ".tool-versions",
    ]
    .iter()
    .any(|name| directory.join(name).is_file())
}

fn has_gradle_marker(directory: &Path) -> bool {
    [
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
    ]
    .iter()
    .any(|name| directory.join(name).is_file())
}

fn has_python_marker(directory: &Path) -> bool {
    [
        "pyproject.toml",
        "Pipfile",
        ".python-version",
        "runtime.txt",
    ]
    .iter()
    .any(|name| directory.join(name).is_file())
}

fn should_skip_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                ".git"
                    | ".gradle"
                    | ".idea"
                    | ".venv"
                    | "venv"
                    | "node_modules"
                    | "target"
                    | "build"
                    | "dist"
                    | "out"
                    | "__pycache__"
            )
        })
}

fn detect_shared_version_files(
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

fn detect_maven(scope: &Path, builder: &mut ProfileBuilder, warnings: &mut Vec<String>) {
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

fn detect_gradle(
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

fn detect_sbt(scope: &Path, builder: &mut ProfileBuilder, warnings: &mut Vec<String>) {
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

fn detect_python(scope: &Path, builder: &mut ProfileBuilder, warnings: &mut Vec<String>) {
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

fn detect_standalone_sources(scope: &Path, builder: &mut ProfileBuilder) {
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

fn maven_properties(contents: &str) -> HashMap<String, String> {
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

fn maven_value(
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

fn maven_plugin_version(
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

fn xml_tag_value(contents: &str, tag: &str) -> Option<String> {
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

fn xml_block_tag_value(contents: &str, block: &str, tag: &str) -> Option<String> {
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

fn property_value(properties: &HashMap<String, String>, key: &str) -> Option<String> {
    properties.get(key).cloned()
}

fn resolve_maven_value(value: &str, properties: &HashMap<String, String>) -> String {
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

fn find_version_catalog(workspace_root: &Path, scope: &Path) -> Option<PathBuf> {
    let local = scope.join("gradle/libs.versions.toml");
    if local.is_file() {
        Some(local)
    } else {
        let root = workspace_root.join("gradle/libs.versions.toml");
        root.is_file().then_some(root)
    }
}

fn kotlin_plugin_from_catalog(
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

fn gradle_applies_kotlin_plugin(contents: &str) -> bool {
    Regex::new(
        r#"(?m)(?:id\s*\(?\s*[\"']org\.jetbrains\.kotlin\.[^\"']+[\"']|kotlin\s*\(\s*[\"'](?:jvm|android|multiplatform|js|wasm|native)[\"']\s*\))"#,
    )
    .ok()
    .is_some_and(|pattern| pattern.is_match(contents))
}

fn gradle_applies_java_plugin(contents: &str) -> bool {
    Regex::new(
        r#"(?ms)(?:id\s*\(?\s*[\"'](?:java|java-library|application)[\"']|plugins\s*\{[^}]*\b(?:java|javaLibrary|application)\b|\bjava\s*\{)"#,
    )
    .ok()
    .is_some_and(|pattern| pattern.is_match(contents))
}

fn gradle_applies_scala_plugin(contents: &str) -> bool {
    Regex::new(r#"(?ms)(?:id\s*\(?\s*[\"']scala[\"']|plugins\s*\{[^}]*\bscala\b|scala-library)"#)
        .ok()
        .is_some_and(|pattern| pattern.is_match(contents))
}

fn read_gradle_property(scope: &Path, key: &str, warnings: &mut Vec<String>) -> Option<String> {
    let path = scope.join("gradle.properties");
    let contents = read_text(&path, warnings)?;
    contents.lines().find_map(|line| {
        let (candidate, value) = line.split_once('=')?;
        (candidate.trim() == key).then(|| value.trim().to_string())
    })
}

fn first_capture(contents: &str, patterns: &[&str]) -> Option<String> {
    patterns.iter().find_map(|pattern| {
        Regex::new(pattern)
            .ok()?
            .captures(contents)?
            .get(1)
            .map(|capture| capture.as_str().trim().to_string())
    })
}

fn directory_has_extension(scope: &Path, extensions: &[&str]) -> bool {
    let mut queue = VecDeque::from([(scope.to_path_buf(), 0_usize)]);
    let mut inspected = 0_usize;
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 4 || inspected >= MAX_STANDALONE_FILES {
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
                if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| matches!(name, "build.gradle.kts" | "settings.gradle.kts"))
                {
                    continue;
                }
                if path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        extensions
                            .iter()
                            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
                    })
                {
                    return true;
                }
            }
        }
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn requirement(
    kind: SdkKind,
    role: SdkRole,
    constraint: Option<SdkVersionConstraint>,
    required_location: Option<String>,
    managed_by_build: bool,
    source: &str,
    confidence: SdkConfidence,
    evidence: SdkEvidence,
) -> SdkRequirement {
    SdkRequirement {
        kind,
        role,
        constraint,
        required_location,
        managed_by_build,
        source: source.to_string(),
        confidence,
        evidence: vec![evidence],
    }
}

fn constraint(raw: &str, policy: SdkConstraintPolicy) -> SdkVersionConstraint {
    SdkVersionConstraint {
        raw: raw.trim().to_string(),
        policy,
        major: version_major(raw),
    }
}

fn version_major(version: &str) -> Option<u32> {
    let pattern = Regex::new(r"[0-9]+").ok()?;
    let mut numbers = pattern
        .find_iter(version)
        .filter_map(|capture| capture.as_str().parse::<u32>().ok());
    let first = numbers.next()?;
    if first == 1 {
        numbers.next().or(Some(first))
    } else {
        Some(first)
    }
}

fn evidence(path: &Path, key: &str, value: &str, confidence: SdkConfidence) -> SdkEvidence {
    SdkEvidence {
        source_path: path_string(path),
        key: key.to_string(),
        value: value.to_string(),
        confidence,
    }
}

fn read_text(path: &Path, warnings: &mut Vec<String>) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    match std::fs::read_to_string(path) {
        Ok(contents) => Some(contents),
        Err(error) => {
            warnings.push(format!("read {}: {error}", path.display()));
            None
        }
    }
}

fn read_trimmed(path: &Path, warnings: &mut Vec<String>) -> Option<String> {
    read_text(path, warnings)
        .map(|contents| contents.trim().to_string())
        .filter(|contents| !contents.is_empty())
}

fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        path_string(left).eq_ignore_ascii_case(&path_string(right))
    } else {
        left == right
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn requirement_for(
        profile: &ProjectSdkProfile,
        kind: SdkKind,
        role: SdkRole,
    ) -> &SdkRequirement {
        profile
            .requirements
            .iter()
            .find(|requirement| requirement.kind == kind && requirement.role == role)
            .unwrap()
    }

    #[test]
    fn detects_maven_java_and_kotlin_without_treating_jvm_target_as_jdk() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("pom.xml"),
            r#"<project>
              <properties>
                <kotlin.version>2.1.20</kotlin.version>
                <kotlin.compiler.languageVersion>2.1</kotlin.compiler.languageVersion>
                <kotlin.compiler.apiVersion>2.0</kotlin.compiler.apiVersion>
                <maven.compiler.release>17</maven.compiler.release>
                <kotlin.compiler.jvmTarget>8</kotlin.compiler.jvmTarget>
              </properties>
              <build><plugins><plugin>
                <artifactId>kotlin-maven-plugin</artifactId>
                <version>${kotlin.version}</version>
              </plugin></plugins></build>
            </project>"#,
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let profile = &analysis.profiles[0];
        let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
        assert_eq!(
            java.constraint.as_ref().and_then(|value| value.major),
            Some(17)
        );
        let kotlin = profile.kotlin.as_ref().unwrap();
        assert_eq!(kotlin.compiler_version.as_deref(), Some("2.1.20"));
        assert_eq!(kotlin.language_version.as_deref(), Some("2.1"));
        assert_eq!(kotlin.api_version.as_deref(), Some("2.0"));
        assert_eq!(kotlin.jvm_target.as_deref(), Some("8"));
        assert!(requirement_for(profile, SdkKind::Kotlin, SdkRole::Compiler).managed_by_build);
    }

    #[test]
    fn treats_maven_jdk_toolchain_as_an_exact_major() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("pom.xml"),
            r#"<project><build><plugins><plugin>
              <artifactId>maven-compiler-plugin</artifactId>
              <configuration><jdkToolchain><version>17</version></jdkToolchain></configuration>
            </plugin></plugins></build></project>"#,
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let java = requirement_for(&analysis.profiles[0], SdkKind::Java, SdkRole::Project);
        assert_eq!(
            java.constraint.as_ref().unwrap().policy,
            SdkConstraintPolicy::ExactMajor
        );
        assert_eq!(java.constraint.as_ref().unwrap().major, Some(17));
    }

    #[test]
    fn detects_gradle_kotlin_toolchain_and_version_catalog() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("build.gradle.kts"),
            r#"plugins { alias(libs.plugins.kotlin.jvm) }
               kotlin { jvmToolchain(17) }
               kotlin { compilerOptions {
                 languageVersion.set(KotlinVersion.KOTLIN_2_1)
                 apiVersion.set(KotlinVersion.KOTLIN_2_0)
                 jvmTarget.set(JvmTarget.JVM_8)
               } }"#,
        );
        write(
            &directory.path().join("gradle.properties"),
            "org.gradle.java.home=/opt/jdk-21\n",
        );
        write(
            &directory.path().join("gradle/libs.versions.toml"),
            r#"[versions]
               kotlin = "2.2.0"
               [plugins]
               kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }"#,
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let profile = &analysis.profiles[0];
        let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
        assert_eq!(
            java.constraint.as_ref().unwrap().policy,
            SdkConstraintPolicy::ExactMajor
        );
        assert_eq!(java.constraint.as_ref().unwrap().major, Some(17));
        let kotlin = profile.kotlin.as_ref().unwrap();
        assert_eq!(kotlin.compiler_version.as_deref(), Some("2.2.0"));
        assert_eq!(kotlin.language_version.as_deref(), Some("2.1"));
        assert_eq!(kotlin.api_version.as_deref(), Some("2.0"));
        assert_eq!(kotlin.jvm_target.as_deref(), Some("8"));
        assert_eq!(kotlin.java_toolchain.as_deref(), Some("17"));
        assert_eq!(
            kotlin.gradle_launcher_java_home.as_deref(),
            Some("/opt/jdk-21")
        );
    }

    #[test]
    fn ignores_unused_kotlin_version_hints() {
        let maven = tempfile::tempdir().unwrap();
        write(
            &maven.path().join("pom.xml"),
            r#"<project><properties>
              <java.version>21</java.version>
              <kotlin.version>2.2.0</kotlin.version>
            </properties></project>"#,
        );
        let analysis = analyze_workspace(&path_string(maven.path())).unwrap();
        let profile = &analysis.profiles[0];
        assert!(!profile.languages.contains(&SdkKind::Kotlin));
        assert!(profile.kotlin.is_none());

        let gradle = tempfile::tempdir().unwrap();
        write(
            &gradle.path().join("build.gradle.kts"),
            "plugins { java }\njava { toolchain.languageVersion.set(JavaLanguageVersion.of(21)) }\n",
        );
        write(
            &gradle.path().join("gradle/libs.versions.toml"),
            r#"[versions]
              kotlin = "2.2.0"
              [plugins]
              kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }"#,
        );
        let analysis = analyze_workspace(&path_string(gradle.path())).unwrap();
        let profile = &analysis.profiles[0];
        assert!(!profile.languages.contains(&SdkKind::Kotlin));
        assert!(profile.kotlin.is_none());
    }

    #[test]
    fn detects_bare_gradle_java_plugin_and_toolchain() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("build.gradle.kts"),
            "plugins { java }\njava { toolchain.languageVersion.set(JavaLanguageVersion.of(17)) }\n",
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let profile = &analysis.profiles[0];
        assert!(profile.languages.contains(&SdkKind::Java));
        let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
        assert_eq!(
            java.constraint.as_ref().unwrap().policy,
            SdkConstraintPolicy::ExactMajor
        );
        assert_eq!(java.constraint.as_ref().unwrap().major, Some(17));
    }

    #[test]
    fn maven_scala_sources_require_java_without_an_explicit_plugin_version() {
        let directory = tempfile::tempdir().unwrap();
        write(&directory.path().join("pom.xml"), "<project />");
        write(
            &directory.path().join("src/main/scala/App.scala"),
            "object App extends App {}\n",
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let profile = &analysis.profiles[0];
        assert!(profile.languages.contains(&SdkKind::Scala));
        assert!(requirement_for(profile, SdkKind::Scala, SdkRole::Compiler).managed_by_build);
        let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
        assert!(java.constraint.is_none());
    }

    #[test]
    fn detects_python_range_and_project_virtual_environment() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join(".venv")).unwrap();
        write(
            &directory.path().join("pyproject.toml"),
            "[project]\nrequires-python = '>=3.11,<3.14'\n",
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let python = requirement_for(&analysis.profiles[0], SdkKind::Python, SdkRole::Project);
        assert_eq!(
            python.constraint.as_ref().unwrap().policy,
            SdkConstraintPolicy::Range
        );
        assert!(
            python
                .required_location
                .as_deref()
                .unwrap()
                .ends_with(".venv")
        );
    }

    #[test]
    fn detects_sbt_compiler_as_build_managed_and_jdk_release_separately() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("build.sbt"),
            r#"ThisBuild / scalaVersion := "3.6.4"
               javacOptions ++= Seq("--release", "21")"#,
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let profile = &analysis.profiles[0];
        let scala = requirement_for(profile, SdkKind::Scala, SdkRole::Compiler);
        assert!(scala.managed_by_build);
        assert_eq!(scala.constraint.as_ref().unwrap().raw, "3.6.4");
        let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
        assert_eq!(java.constraint.as_ref().unwrap().major, Some(21));
    }

    #[test]
    fn keeps_kmp_targets_from_creating_jdk_requirement_without_jvm_toolchain() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("build.gradle.kts"),
            r#"plugins { kotlin("multiplatform") version "2.2.0" }
               kotlin { js(); linuxX64() }"#,
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let profile = &analysis.profiles[0];
        assert_eq!(
            profile.kotlin.as_ref().unwrap().platform,
            KotlinPlatform::Multiplatform
        );
        assert!(
            !profile
                .requirements
                .iter()
                .any(|requirement| requirement.kind == SdkKind::Java)
        );
    }

    #[test]
    fn detects_kotlin_platform_from_an_applied_catalog_alias() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("build.gradle.kts"),
            r#"plugins { alias(libs.plugins.kotlin.multiplatform) }
               kotlin { js(); linuxX64() }"#,
        );
        write(
            &directory.path().join("gradle/libs.versions.toml"),
            r#"[versions]
               kotlin = "2.2.0"
               [plugins]
               kotlin-multiplatform = { id = "org.jetbrains.kotlin.multiplatform", version.ref = "kotlin" }"#,
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        let profile = &analysis.profiles[0];
        let kotlin = profile.kotlin.as_ref().unwrap();
        assert_eq!(kotlin.platform, KotlinPlatform::Multiplatform);
        assert_eq!(kotlin.compiler_version.as_deref(), Some("2.2.0"));
        assert!(
            !profile
                .requirements
                .iter()
                .any(|requirement| requirement.kind == SdkKind::Java)
        );
    }

    #[test]
    fn discovers_nested_module_profiles_without_scanning_dependency_directories() {
        let directory = tempfile::tempdir().unwrap();
        write(&directory.path().join("pom.xml"), "<project />");
        write(
            &directory.path().join("service/.python-version"),
            "3.12.2\n",
        );
        write(
            &directory
                .path()
                .join("node_modules/ignored/.python-version"),
            "2.7\n",
        );

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        assert!(
            analysis
                .profiles
                .iter()
                .any(|profile| profile.relative_path.ends_with("service"))
        );
        assert!(
            !analysis
                .profiles
                .iter()
                .any(|profile| profile.relative_path.contains("node_modules"))
        );
    }

    #[test]
    fn standalone_root_does_not_duplicate_nested_project_sources() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("service/.python-version"),
            "3.12.2\n",
        );
        write(&directory.path().join("service/main.py"), "print('ok')\n");

        let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
        assert_eq!(analysis.profiles.len(), 1);
        assert!(analysis.profiles[0].relative_path.ends_with("service"));
    }
}
