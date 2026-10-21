use super::*;

pub(super) fn detect_jvm_languages(root: &Path) -> Vec<&'static str> {
    let mut languages = BTreeSet::new();
    for entry in WalkBuilder::new(root)
        .max_depth(Some(6))
        .filter_entry(manifest_entry)
        .build()
        .flatten()
    {
        match entry.path().extension().and_then(|value| value.to_str()) {
            Some("java") => {
                languages.insert("java");
            }
            Some("kt") | Some("kts") => {
                languages.insert("kotlin");
            }
            Some("scala") => {
                languages.insert("scala");
            }
            _ => {}
        }
    }
    languages.into_iter().collect()
}

pub(super) fn jvm_main_regex() -> &'static Regex {
    static MAIN: OnceLock<Regex> = OnceLock::new();
    MAIN.get_or_init(|| {
        Regex::new(r"(?m)(?:static\s+void\s+main\s*\(|fun\s+main\s*\(|def\s+main\s*\()")
            .expect("valid JVM main regex")
    })
}

pub(super) fn add_jvm(
    builder: &mut ModelBuilder,
    manifest: &Path,
    config: Option<&WorkspaceToolConfig>,
) {
    let root = manifest.parent().unwrap_or(manifest);
    let languages = detect_jvm_languages(root);
    let language_refs = if languages.is_empty() {
        vec!["java"]
    } else {
        languages
    };
    let provider = if manifest.file_name().and_then(|value| value.to_str()) == Some("pom.xml") {
        "maven"
    } else {
        "gradle"
    };
    let project = builder.project(provider, manifest, &language_refs, provider);
    let (tool, tasks): (ToolProbe, &[(&str, &str, &[&str])]) = if provider == "maven" {
        let tool = builder.tool(
            root,
            config,
            "maven",
            "Maven",
            &["mvnw", "mvnw.cmd", "mvnw.bat"],
            &["mvn"],
            "Install Maven, configure it, or add the Maven wrapper.",
        );
        (
            tool,
            &[
                ("Compile", "build", &["compile"]),
                ("Package", "build", &["package"]),
                ("Test", "test", &["test"]),
                ("Clean", "clean", &["clean"]),
            ],
        )
    } else {
        let tool = builder.tool(
            root,
            config,
            "gradle",
            "Gradle",
            &["gradlew", "gradlew.bat", "gradlew.cmd"],
            &["gradle"],
            "Install Gradle, configure it, or add the Gradle wrapper.",
        );
        (
            tool,
            &[
                ("Classes", "build", &["classes"]),
                ("Build", "build", &["build"]),
                ("Test", "test", &["test"]),
                ("Clean", "clean", &["clean"]),
            ],
        )
    };
    let builds = add_common_builds(builder, &project, &tool, tasks);
    if provider == "gradle" {
        builder.run(
            &project,
            "Run application",
            "application",
            command(
                &tool,
                vec!["run".to_string(), "--args".to_string(), "".to_string()],
                root,
            ),
            None,
            builds.get("build").cloned().into_iter().collect(),
            None,
        );
    }
    // Bounded source discovery records explicit mains for Maven run. Gradle's
    // Application plugin remains the authority for its main class.
    if provider == "maven" {
        for (_, source) in ["java", "kt", "scala"]
            .into_iter()
            .flat_map(|extension| source_directories(root, extension, jvm_main_regex()))
        {
            let class = source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Main");
            builder.run(
                &project,
                &format!("Run {class}"),
                "main-class",
                command(
                    &tool,
                    vec![
                        "compile".to_string(),
                        "org.codehaus.mojo:exec-maven-plugin:3.5.0:java".to_string(),
                        format!("-Dexec.mainClass={class}"),
                        "-Dexec.args=".to_string(),
                    ],
                    root,
                ),
                Some(path_string(&source)),
                builds.get("build").cloned().into_iter().collect(),
                None,
            );
        }
    }
}

pub(super) fn scala_main_name(source: &str) -> Option<String> {
    let package = Regex::new(r"(?m)^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)")
        .ok()?
        .captures(source)
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str());
    let object = Regex::new(r"(?m)^\s*object\s+([A-Za-z_][A-Za-z0-9_]*)[^\n]*")
        .ok()?
        .captures(source)?
        .get(1)?
        .as_str();
    Some(
        package
            .map(|prefix| format!("{prefix}.{object}"))
            .unwrap_or_else(|| object.to_string()),
    )
}

pub(super) fn add_sbt(
    builder: &mut ModelBuilder,
    manifest: &Path,
    config: Option<&WorkspaceToolConfig>,
) {
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("sbt", manifest, &["scala"], "sbt");
    let sbt = builder.tool(
        root,
        config,
        "sbt",
        "sbt",
        &["sbt", "sbt.bat"],
        &["sbt"],
        "Install sbt, configure it, or add the sbt launcher script.",
    );
    let builds = add_common_builds(
        builder,
        &project,
        &sbt,
        &[
            ("Compile", "build", &["compile"]),
            ("Test", "test", &["test"]),
            ("Clean", "clean", &["clean"]),
        ],
    );
    for (_, source) in source_directories(root, "scala", jvm_main_regex()) {
        let Ok(contents) = read_text(&source) else {
            continue;
        };
        let Some(main) = scala_main_name(&contents) else {
            continue;
        };
        builder.run(
            &project,
            &format!("Run {main}"),
            "main-class",
            command(&sbt, vec![format!("runMain {main}")], root),
            Some(path_string(&source)),
            builds.get("build").cloned().into_iter().collect(),
            None,
        );
    }
}
