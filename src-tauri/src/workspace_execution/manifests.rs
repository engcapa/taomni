use super::*;

pub(super) fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub(super) fn shared_project_model(workspace_root: &Path) -> ProjectModel {
    let id = "shared:workspace".to_string();
    ProjectModel {
        module_id: stable_id("module", &[&id, &path_string(workspace_root)]),
        id,
        provider: "shared".to_string(),
        root: path_string(workspace_root),
        manifest: path_string(&workspace_root.join(SHARED_RUN_CONFIG_RELATIVE_PATH)),
        module: workspace_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workspace")
            .to_string(),
        languages: Vec::new(),
        language_level: None,
        toolchain: "shared".to_string(),
        diagnostics: Vec::new(),
    }
}

pub(super) fn stable_id(prefix: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hex::encode(hasher.finalize());
    format!("{prefix}:{}", &digest[..16])
}

pub(super) fn first_capture(contents: &str, patterns: &[&str]) -> Option<String> {
    patterns.iter().find_map(|pattern| {
        Regex::new(pattern)
            .ok()?
            .captures(contents)?
            .get(1)
            .map(|value| value.as_str().trim().to_string())
    })
}

pub(super) fn maven_language_level(contents: &str) -> Option<String> {
    let configured = first_capture(
        contents,
        &[
            r"<maven\.compiler\.release>\s*([^<]+)\s*</maven\.compiler\.release>",
            r"<maven\.compiler\.source>\s*([^<]+)\s*</maven\.compiler\.source>",
        ],
    );
    let value = configured
        .or_else(|| first_capture(contents, &[r"<java\.version>\s*([^<]+)\s*</java\.version>"]))?;
    let Some(property) = value
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
    else {
        return Some(value);
    };
    if property.is_empty()
        || !property
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return None;
    }
    let pattern = format!(
        r"<{}>\s*([^<]+)\s*</{}>",
        regex::escape(property),
        regex::escape(property)
    );
    first_capture(contents, &[&pattern])
}

pub(super) fn detect_language_level(provider: &str, manifest: &Path) -> Option<String> {
    let contents = read_text(manifest).ok()?;
    let (prefix, value) = match provider {
        "cargo" => (
            "rust",
            first_capture(&contents, &[r#"(?m)^\s*edition\s*=\s*["']([^"']+)["']"#])?,
        ),
        "go" => (
            "go",
            first_capture(&contents, &[r"(?m)^\s*go\s+([0-9]+(?:\.[0-9]+)*)\s*$"])?,
        ),
        "python" => (
            "python",
            first_capture(
                &contents,
                &[r#"(?m)^\s*requires-python\s*=\s*["']([^"']+)["']"#],
            )?,
        ),
        "node" => {
            let value = serde_json::from_str::<Value>(&contents)
                .ok()?
                .pointer("/engines/node")?
                .as_str()?
                .trim()
                .to_string();
            ("node", value)
        }
        "maven" => ("java", maven_language_level(&contents)?),
        "gradle" => (
            "java",
            first_capture(
                &contents,
                &[
                    r"JavaLanguageVersion\.of\s*\(\s*([0-9]+)\s*\)",
                    r"jvmToolchain\s*\(\s*([0-9]+)\s*\)",
                    r#"sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?["']?([0-9_\.]+)"#,
                ],
            )?
            .replace('_', "."),
        ),
        "sbt" => (
            "scala",
            first_capture(
                &contents,
                &[r#"(?m)^\s*(?:ThisBuild\s*/\s*)?scalaVersion\s*:?=\s*["']([^"']+)["']"#],
            )?,
        ),
        "dotnet" => (
            "dotnet",
            first_capture(
                &contents,
                &[r"<TargetFramework>\s*([^<]+)\s*</TargetFramework>"],
            )?,
        ),
        "cmake" => (
            "cpp",
            first_capture(
                &contents,
                &[r"CMAKE_CXX_STANDARD\s+([0-9]+)", r"cxx_std_([0-9]+)"],
            )?,
        ),
        "swiftpm" => (
            "swift",
            first_capture(
                &contents,
                &[r"(?m)^\s*//\s*swift-tools-version:\s*([0-9]+(?:\.[0-9]+)*)"],
            )?,
        ),
        _ => return None,
    };
    (!value.is_empty()).then(|| format!("{prefix}:{value}"))
}

pub(super) fn source_set(
    project: &ProjectModel,
    name: &str,
    kind: &str,
    roots: Vec<PathBuf>,
    generated: bool,
) -> Option<SourceSetModel> {
    let mut roots = roots
        .into_iter()
        .filter(|root| root.is_dir())
        .map(|root| path_string(&root))
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    if roots.is_empty() {
        return None;
    }
    Some(SourceSetModel {
        id: stable_id("source-set", &[&project.module_id, name, kind]),
        project_id: project.id.clone(),
        module_id: project.module_id.clone(),
        name: name.to_string(),
        kind: kind.to_string(),
        roots,
        generated,
        language_level: project.language_level.clone(),
    })
}

pub(super) fn discover_source_sets(project: &ProjectModel) -> Vec<SourceSetModel> {
    let root = Path::new(&project.root);
    let mut main_roots = Vec::new();
    let mut test_roots = Vec::new();
    let mut generated_roots = Vec::new();
    match project.provider.as_str() {
        "maven" | "gradle" | "sbt" => {
            for language in &project.languages {
                main_roots.push(root.join("src/main").join(language));
                test_roots.push(root.join("src/test").join(language));
            }
            main_roots.push(root.join("src/main/resources"));
            test_roots.push(root.join("src/test/resources"));
            generated_roots.extend([
                root.join("target/generated-sources"),
                root.join("build/generated/sources"),
            ]);
        }
        "cargo" => {
            main_roots.push(root.join("src"));
            test_roots.push(root.join("tests"));
            generated_roots.push(root.join("target/generated"));
        }
        "swiftpm" => {
            main_roots.push(root.join("Sources"));
            test_roots.push(root.join("Tests"));
        }
        "cmake" => {
            main_roots.extend([root.join("src"), root.join("include")]);
            test_roots.extend([root.join("tests"), root.join("test")]);
            generated_roots.push(root.join("build/generated"));
        }
        "node" => {
            main_roots.push(root.join("src"));
            test_roots.extend([root.join("test"), root.join("tests")]);
            generated_roots.push(root.join("generated"));
        }
        "python" => {
            main_roots.push(root.join("src"));
            test_roots.extend([root.join("test"), root.join("tests")]);
        }
        "go" | "dotnet" => {
            main_roots.push(root.to_path_buf());
            test_roots.extend([root.join("test"), root.join("tests")]);
        }
        _ => main_roots.push(root.to_path_buf()),
    }
    if !main_roots.iter().any(|candidate| candidate.is_dir()) {
        main_roots.push(root.to_path_buf());
    }
    [
        source_set(project, "main", "production", main_roots, false),
        source_set(project, "test", "test", test_roots, false),
        source_set(project, "generated", "generated", generated_roots, true),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub(super) fn compile_artifact_kind(provider: &str, label: &str) -> &'static str {
    let label = label.to_ascii_lowercase();
    match provider {
        "cargo" => "cargo-compiler-artifact",
        "go" => "go-package",
        "node" => "script-output",
        "python" => "python-distribution",
        "cmake" => "cmake-target",
        "dotnet" => "dotnet-assembly",
        "maven" | "gradle" | "sbt" if label.contains("compile") || label.contains("class") => {
            "jvm-classes"
        }
        "maven" | "gradle" | "sbt" => "jvm-artifact",
        "swiftpm" => "swift-product",
        _ => "provider-output",
    }
}

pub(super) fn compile_artifact_diagnostic(provider: &str) -> &'static str {
    match provider {
        "cargo" => "Artifact path resolves from Cargo compiler-artifact JSON after build.",
        "cmake" => "Artifact path requires CMake file-api target output.",
        "dotnet" => "Artifact path requires MSBuild target framework output.",
        "maven" | "gradle" | "sbt" => {
            "Artifact path requires the imported build-tool module and task result."
        }
        "swiftpm" => "Artifact path resolves from SwiftPM bin-path output after build.",
        _ => "Artifact path remains unresolved until the provider reports build output.",
    }
}

pub(super) fn resolve_existing_artifact_path(
    root: &Path,
    provider: &str,
    label: &str,
) -> Option<PathBuf> {
    let label_lower = label.to_ascii_lowercase();
    match provider {
        "maven" => {
            if label_lower.contains("compile") || label_lower.contains("class") {
                let classes = root.join("target/classes");
                if classes.is_dir() {
                    return Some(classes);
                }
            } else if label_lower.contains("package") || label_lower.contains("build") {
                let target = root.join("target");
                if let Ok(entries) = fs::read_dir(&target) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|ext| ext.to_str()) == Some("jar") {
                            return Some(path);
                        }
                    }
                }
            }
            None
        }
        "gradle" => {
            if label_lower.contains("class") || label_lower.contains("compile") {
                for candidate in [
                    "build/classes/java/main",
                    "build/classes/kotlin/main",
                    "build/classes",
                ] {
                    let dir = root.join(candidate);
                    if dir.is_dir() {
                        return Some(dir);
                    }
                }
            } else if label_lower.contains("build") || label_lower.contains("package") {
                let libs = root.join("build/libs");
                if let Ok(entries) = fs::read_dir(&libs) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|ext| ext.to_str()) == Some("jar") {
                            return Some(path);
                        }
                    }
                }
            }
            None
        }
        "cargo" => {
            for candidate in ["target/debug", "target/release"] {
                let dir = root.join(candidate);
                if dir.is_dir() {
                    return Some(dir);
                }
            }
            None
        }
        "node" => {
            for candidate in ["dist", "build", "lib", "out"] {
                let dir = root.join(candidate);
                if dir.is_dir() {
                    return Some(dir);
                }
            }
            None
        }
        "cmake" => {
            let build = root.join("build");
            if build.is_dir() { Some(build) } else { None }
        }
        "dotnet" => {
            for candidate in ["bin/Debug", "bin/Release", "bin"] {
                let dir = root.join(candidate);
                if dir.is_dir() {
                    return Some(dir);
                }
            }
            None
        }
        _ => None,
    }
}

pub(super) fn parse_maven_modules(pom_content: &str) -> Vec<String> {
    static MODULE_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = MODULE_REGEX.get_or_init(|| {
        Regex::new(r"<module>\s*([^<\s]+)\s*</module>").expect("valid maven module regex")
    });
    regex
        .captures_iter(pom_content)
        .filter_map(|capture| capture.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|m| !m.is_empty())
        .collect()
}

pub(super) fn parse_gradle_settings_modules(settings_content: &str) -> Vec<String> {
    static INCLUDE_LINE_REGEX: OnceLock<Regex> = OnceLock::new();
    let include_line_regex = INCLUDE_LINE_REGEX.get_or_init(|| {
        Regex::new(r#"(?m)^\s*include\b([^\n\r]+)"#).expect("valid include line regex")
    });
    static QUOTED_REGEX: OnceLock<Regex> = OnceLock::new();
    let quoted_regex = QUOTED_REGEX.get_or_init(|| {
        Regex::new(r#"['"](?::)?([a-zA-Z0-9_\-:]+)['"]"#).expect("valid quoted regex")
    });

    let mut modules = Vec::new();
    for capture in include_line_regex.captures_iter(settings_content) {
        if let Some(rest) = capture.get(1) {
            for item in quoted_regex.captures_iter(rest.as_str()) {
                if let Some(name) = item.get(1) {
                    let cleaned = name
                        .as_str()
                        .trim_start_matches(':')
                        .replace(':', "/")
                        .trim()
                        .to_string();
                    if !cleaned.is_empty() {
                        modules.push(cleaned);
                    }
                }
            }
        }
    }
    modules
}

pub(super) fn parse_gradle_project_dependencies(build_content: &str) -> Vec<String> {
    static GRADLE_DEP_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = GRADLE_DEP_REGEX.get_or_init(|| {
        Regex::new(r#"project\s*\(\s*['":]([a-zA-Z0-9_\-:]+)['"]\s*\)"#)
            .expect("valid gradle dep regex")
    });
    regex
        .captures_iter(build_content)
        .filter_map(|capture| {
            capture
                .get(1)
                .map(|m| m.as_str().trim_start_matches(':').trim().to_string())
        })
        .filter(|m| !m.is_empty())
        .collect()
}

pub(super) fn manifest_entry(entry: &DirEntry) -> bool {
    if !entry.file_type().is_some_and(|kind| kind.is_dir()) {
        return true;
    }
    !matches!(
        entry.file_name().to_string_lossy().as_ref(),
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | ".gradle"
            | ".idea"
    )
}

pub(super) fn discover_manifests(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut manifests = Vec::new();
    for result in WalkBuilder::new(root)
        .max_depth(Some(MAX_MANIFEST_DEPTH))
        .hidden(false)
        .filter_entry(manifest_entry)
        .build()
    {
        let entry = result.map_err(|error| format!("scan {}: {error}", root.display()))?;
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if matches!(
            name.as_ref(),
            "Cargo.toml"
                | "go.mod"
                | "package.json"
                | "pyproject.toml"
                | "CMakeLists.txt"
                | "pom.xml"
                | "build.gradle"
                | "build.gradle.kts"
                | "build.sbt"
                | "Package.swift"
        ) || name.ends_with(".csproj")
        {
            manifests.push(entry.into_path());
        }
    }
    manifests.sort();
    Ok(manifests)
}

pub(super) fn read_text(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "{} exceeds the 2 MiB discovery limit",
            path.display()
        ));
    }
    fs::read_to_string(path).map_err(|error| format!("read {}: {error}", path.display()))
}

pub(super) fn active_in_project(
    active_file: Option<&Path>,
    project_root: &Path,
    extensions: &[&str],
) -> Option<PathBuf> {
    let active = active_file?;
    if !active.starts_with(project_root) {
        return None;
    }
    let extension = active.extension()?.to_str()?.to_ascii_lowercase();
    extensions
        .contains(&extension.as_str())
        .then(|| active.to_path_buf())
}

pub(super) fn add_common_builds(
    builder: &mut ModelBuilder,
    project: &ProjectModel,
    tool: &ToolProbe,
    tasks: &[(&str, &str, &[&str])],
) -> BTreeMap<String, String> {
    let root = Path::new(&project.root);
    let mut ids = BTreeMap::new();
    for (label, kind, args) in tasks {
        let id = builder.build(
            project,
            label,
            kind,
            command(
                tool,
                args.iter().map(|value| (*value).to_string()).collect(),
                root,
            ),
        );
        ids.insert((*kind).to_string(), id);
    }
    ids
}

pub(super) fn canonical_root(repo_root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(repo_root)
        .map_err(|error| format!("resolve workspace root `{repo_root}`: {error}"))?;
    if !root.is_dir() {
        return Err(format!(
            "workspace root is not a directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

pub(super) fn resolve_active(root: &Path, active_file: Option<&str>) -> Option<PathBuf> {
    let active = active_file?.trim();
    if active.is_empty() {
        return None;
    }
    let path = Path::new(active);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let canonical = fs::canonicalize(joined).ok()?;
    canonical.starts_with(root).then_some(canonical)
}

pub fn detect_execution_model(
    root: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<WorkspaceExecutionModel, String> {
    let mut builder = ModelBuilder::default();
    let manifests = discover_manifests(root)?;
    // Gradle projects often contain both build.gradle and build.gradle.kts while
    // transitioning. One provider per directory keeps stable ids unambiguous.
    let mut seen_provider_roots = BTreeSet::<(String, PathBuf)>::new();
    for manifest in manifests {
        let name = manifest
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let provider = match name {
            "Cargo.toml" => "cargo",
            "go.mod" => "go",
            "package.json" => "node",
            "pyproject.toml" => "python",
            "CMakeLists.txt" => "cmake",
            "pom.xml" => "maven",
            "build.gradle" | "build.gradle.kts" => "gradle",
            "build.sbt" => "sbt",
            "Package.swift" => "swiftpm",
            value if value.ends_with(".csproj") => "dotnet",
            _ => continue,
        };
        let project_root = manifest.parent().unwrap_or(&manifest).to_path_buf();
        if !seen_provider_roots.insert((provider.to_string(), project_root)) {
            continue;
        }
        match provider {
            "cargo" => add_cargo(&mut builder, &manifest, active_file, config)?,
            "go" => add_go(&mut builder, &manifest, active_file, config)?,
            "node" => add_node(&mut builder, &manifest, active_file, config)?,
            "python" => add_python(&mut builder, &manifest, active_file, config)?,
            "cmake" => add_cmake(&mut builder, &manifest, config),
            "dotnet" => add_dotnet(&mut builder, &manifest, config),
            "maven" | "gradle" => add_jvm(&mut builder, &manifest, config),
            "sbt" => add_sbt(&mut builder, &manifest, config),
            "swiftpm" => add_swift(&mut builder, &manifest, config)?,
            _ => {}
        }
    }
    merge_shared_configurations(&mut builder, root);
    Ok(builder.finish())
}
