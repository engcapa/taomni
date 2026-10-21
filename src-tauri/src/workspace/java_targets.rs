use super::*;

pub(super) const JAVA_RUN_SCAN_MAX_FILES: usize = 5_000;
pub(super) const JAVA_RUN_SCAN_MAX_DEPTH: usize = 25;
pub(super) const JAVA_RUN_SOURCE_MAX_BYTES: u64 = 2 * 1024 * 1024;
pub(super) const GRADLE_JAVA_RUN_INIT: &str = r#"allprojects { project ->
    project.afterEvaluate {
        if (project.plugins.hasPlugin('java') && project.tasks.findByName('taomniRun') == null) {
            project.tasks.register('taomniRun', JavaExec) {
                group = 'application'
                description = 'Run a Java main class selected by Taomni'
                classpath = project.sourceSets.main.runtimeClasspath
                def selectedMain = project.findProperty('taomniMainClass')
                if (selectedMain == null || selectedMain.toString().trim().isEmpty()) {
                    throw new GradleException('Missing -PtaomniMainClass')
                }
                if (delegate.hasProperty('mainClass')) {
                    mainClass.set(selectedMain.toString())
                } else {
                    main = selectedMain.toString()
                }
                standardInput = System.in
            }
        }
    }
}
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum JavaBuildSystem {
    Maven,
    Gradle,
    SourceFile,
}

pub(super) fn java_main_regex() -> &'static Regex {
    static MAIN: OnceLock<Regex> = OnceLock::new();
    MAIN.get_or_init(|| {
        Regex::new(
            r"(?s)\b(?:public\s+)?static\s+void\s+main\s*\(\s*(?:final\s+)?(?:java\.lang\.)?String\s*(?:\[\s*\]\s*[A-Za-z_$][A-Za-z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*\s*\[\s*\]|\.{3}\s*[A-Za-z_$][A-Za-z0-9_$]*)\s*\)",
        )
        .expect("valid Java main regex")
    })
}

pub(super) fn java_package_regex() -> &'static Regex {
    static PACKAGE: OnceLock<Regex> = OnceLock::new();
    PACKAGE.get_or_init(|| {
        Regex::new(
            r"(?m)^\s*package\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*;",
        )
        .expect("valid Java package regex")
    })
}

pub(super) fn maven_arg_line_regex() -> &'static Regex {
    static ARG_LINE: OnceLock<Regex> = OnceLock::new();
    ARG_LINE.get_or_init(|| {
        Regex::new(r"(?is)<argLine(?:\s[^>]*)?>(.*?)</argLine\s*>")
            .expect("valid Maven argLine regex")
    })
}

pub(super) fn xml_comment_regex() -> &'static Regex {
    static XML_COMMENT: OnceLock<Regex> = OnceLock::new();
    XML_COMMENT.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").expect("valid XML comment regex"))
}

pub(super) fn is_inheritable_maven_jvm_option(value: &str) -> bool {
    [
        "--add-opens",
        "--add-exports",
        "--add-reads",
        "--add-modules",
        "--enable-native-access",
    ]
    .iter()
    .any(|option| value == *option || value.starts_with(&format!("{option}=")))
}

/// Read JPMS/native-access options from Maven test-plugin `argLine` elements.
///
/// `exec:java` runs the application inside Maven's JVM, while Surefire/Failsafe
/// normally fork a JVM and apply `argLine` only there. Reusing only these
/// module-access options through MAVEN_OPTS makes Run behave like the project's
/// tests without also inheriting agents, heap limits, or arbitrary properties.
pub(super) fn maven_inherited_jvm_args(workspace_root: &Path, build_dir: &Path) -> Vec<String> {
    let mut directories = Vec::new();
    let mut current = Some(build_dir);
    while let Some(directory) = current {
        if !directory.starts_with(workspace_root) {
            break;
        }
        directories.push(directory.to_path_buf());
        if directory == workspace_root {
            break;
        }
        current = directory.parent();
    }
    directories.reverse();

    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for directory in directories {
        let Ok(pom) = fs::read_to_string(directory.join("pom.xml")) else {
            continue;
        };
        let pom = xml_comment_regex().replace_all(&pom, "");
        for captures in maven_arg_line_regex().captures_iter(&pom) {
            let Some(arg_line) = captures.get(1) else {
                continue;
            };
            let tokens = arg_line
                .as_str()
                .replace("<![CDATA[", "")
                .replace("]]>", "")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&gt;", ">")
                .replace("&lt;", "<")
                .replace("&amp;", "&")
                .split_whitespace()
                .map(|value| value.trim_matches(['"', '\'']).to_string())
                .collect::<Vec<_>>();
            let mut index = 0;
            while index < tokens.len() {
                let token = &tokens[index];
                if !is_inheritable_maven_jvm_option(token) {
                    index += 1;
                    continue;
                }
                let option = if token.contains('=') {
                    token.clone()
                } else if let Some(value) = tokens.get(index + 1).filter(|value| {
                    !value.starts_with('-') && !value.starts_with('$') && !value.starts_with('@')
                }) {
                    index += 1;
                    format!("{token}={value}")
                } else {
                    index += 1;
                    continue;
                };
                if seen.insert(option.clone()) {
                    result.push(option);
                }
                index += 1;
            }
        }
    }
    result
}

pub(super) fn maven_run_environment(
    workspace_root: &Path,
    build_dir: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Option<WorkspaceTaskEnvironment> {
    let mut args = if tool_config
        .map(WorkspaceToolConfig::inherits_maven_arg_line)
        .unwrap_or(true)
    {
        maven_inherited_jvm_args(workspace_root, build_dir)
    } else {
        Vec::new()
    };
    if let Some(config) = tool_config {
        args.extend(
            config
                .maven_jvm_args
                .iter()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        );
    }
    let mut seen = HashSet::new();
    args.retain(|value| seen.insert(value.clone()));
    if args.is_empty() {
        return None;
    }
    Some(BTreeMap::from([(
        "MAVEN_OPTS".into(),
        WorkspaceTaskEnvironmentVariable {
            value: args.join(" "),
            mode: "append".into(),
        },
    )]))
}

/// Strip comments and string/char/text-block contents before looking for a
/// main signature. This avoids presenting a Run action for examples embedded
/// in Javadoc or string literals while keeping line structure irrelevant.
pub(super) fn java_code_only(source: &str) -> String {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum State {
        Code,
        LineComment,
        BlockComment,
        String,
        Character,
        TextBlock,
    }

    let bytes = source.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut state = State::Code;
    let mut i = 0;
    while i < bytes.len() {
        let current = bytes[i];
        let next = bytes.get(i + 1).copied();
        let third = bytes.get(i + 2).copied();
        match state {
            State::Code if current == b'/' && next == Some(b'/') => {
                out.push_str("  ");
                state = State::LineComment;
                i += 2;
            }
            State::Code if current == b'/' && next == Some(b'*') => {
                out.push_str("  ");
                state = State::BlockComment;
                i += 2;
            }
            State::Code if current == b'"' && next == Some(b'"') && third == Some(b'"') => {
                out.push_str("   ");
                state = State::TextBlock;
                i += 3;
            }
            State::Code if current == b'"' => {
                out.push(' ');
                state = State::String;
                i += 1;
            }
            State::Code if current == b'\'' => {
                out.push(' ');
                state = State::Character;
                i += 1;
            }
            State::LineComment if current == b'\n' => {
                out.push('\n');
                state = State::Code;
                i += 1;
            }
            State::BlockComment if current == b'*' && next == Some(b'/') => {
                out.push_str("  ");
                state = State::Code;
                i += 2;
            }
            State::TextBlock if current == b'"' && next == Some(b'"') && third == Some(b'"') => {
                out.push_str("   ");
                state = State::Code;
                i += 3;
            }
            State::String | State::Character if current == b'\\' && next.is_some() => {
                out.push_str("  ");
                i += 2;
            }
            State::String if current == b'"' => {
                out.push(' ');
                state = State::Code;
                i += 1;
            }
            State::Character if current == b'\'' => {
                out.push(' ');
                state = State::Code;
                i += 1;
            }
            State::Code => {
                out.push(current as char);
                i += 1;
            }
            _ => {
                out.push(if current == b'\n' { '\n' } else { ' ' });
                i += 1;
            }
        }
    }
    out
}

pub(super) fn shell_quote(value: &str) -> String {
    if cfg!(windows) {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

pub(super) fn nearest_java_build(
    workspace_root: &Path,
    source_file: &Path,
) -> (JavaBuildSystem, PathBuf) {
    let mut current = source_file.parent();
    while let Some(dir) = current {
        if dir.join("pom.xml").is_file() {
            return (JavaBuildSystem::Maven, dir.to_path_buf());
        }
        if dir.join("build.gradle").is_file() || dir.join("build.gradle.kts").is_file() {
            return (JavaBuildSystem::Gradle, dir.to_path_buf());
        }
        if dir == workspace_root {
            break;
        }
        current = dir
            .parent()
            .filter(|parent| parent.starts_with(workspace_root));
    }
    (JavaBuildSystem::SourceFile, workspace_root.to_path_buf())
}

pub(super) fn gradle_invocation_root(workspace_root: &Path, build_dir: &Path) -> PathBuf {
    let mut result = build_dir.to_path_buf();
    let mut current = Some(build_dir);
    while let Some(dir) = current {
        if dir.join("settings.gradle").is_file() || dir.join("settings.gradle.kts").is_file() {
            result = dir.to_path_buf();
            break;
        }
        if dir == workspace_root {
            break;
        }
        current = dir
            .parent()
            .filter(|parent| parent.starts_with(workspace_root));
    }
    result
}

pub(super) fn gradle_run_init_script() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("taomni-code-workspace");
    fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "create Gradle run support directory {}: {error}",
            dir.display()
        )
    })?;
    let path = dir.join("java-run.init.gradle");
    let should_write = fs::read_to_string(&path)
        .map(|current| current != GRADLE_JAVA_RUN_INIT)
        .unwrap_or(true);
    if should_write {
        fs::write(&path, GRADLE_JAVA_RUN_INIT)
            .map_err(|error| format!("write Gradle run support {}: {error}", path.display()))?;
    }
    Ok(path)
}

pub(super) fn java_run_target_for_path(
    workspace_root: &Path,
    source_file: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Result<JavaRunTarget, String> {
    let metadata = fs::metadata(source_file)
        .map_err(|error| format!("stat {}: {error}", source_file.display()))?;
    if metadata.len() > JAVA_RUN_SOURCE_MAX_BYTES {
        return Err(format!(
            "Java source is too large to inspect for a main class: {}",
            source_file.display()
        ));
    }
    let source = fs::read_to_string(source_file)
        .map_err(|error| format!("read {}: {error}", source_file.display()))?;
    let code = java_code_only(&source);
    if !java_main_regex().is_match(&code) {
        return Err("No `static void main(String[] args)` entry point found in this file".into());
    }
    let class_name = source_file
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("Invalid Java source file name: {}", source_file.display()))?;
    let package_name = java_package_regex()
        .captures(&code)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str());
    let main_class = package_name
        .map(|package| format!("{package}.{class_name}"))
        .unwrap_or_else(|| class_name.to_string());
    let relative_file = relative_path(workspace_root, source_file)?;
    let (build_system, build_dir) = nearest_java_build(workspace_root, source_file);
    let (command, cwd, module_path, build_system_name, execution, environment) = match build_system
    {
        JavaBuildSystem::Maven => {
            let resolution =
                resolve_build_tool(&build_dir, workspace_root, BuildTool::Maven, tool_config);
            let runner = resolution.task_runner(HostPlatform::current());
            let main_class_arg = format!("-Dexec.mainClass={main_class}");
            let cleanup_arg = "-Dexec.cleanupDaemonThreads=false".to_string();
            let args = vec![
                "-q".into(),
                "-DskipTests".into(),
                main_class_arg.clone(),
                cleanup_arg.clone(),
                "compile".into(),
                "org.codehaus.mojo:exec-maven-plugin:3.5.0:java".into(),
            ];
            let command = format!(
                "{runner} -q -DskipTests {} {} compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java",
                shell_quote(&main_class_arg),
                shell_quote(&cleanup_arg),
            );
            (
                command,
                path_to_string(&build_dir),
                relative_path(workspace_root, &build_dir).unwrap_or_else(|_| ".".into()),
                "maven",
                resolution.execution_owned(args),
                maven_run_environment(workspace_root, &build_dir, tool_config),
            )
        }
        JavaBuildSystem::Gradle => {
            let invocation_root = gradle_invocation_root(workspace_root, &build_dir);
            let resolution = resolve_build_tool(
                &invocation_root,
                workspace_root,
                BuildTool::Gradle,
                tool_config,
            );
            let runner = resolution.task_runner(HostPlatform::current());
            let init_script = gradle_run_init_script()?;
            let module_relative = build_dir
                .strip_prefix(&invocation_root)
                .ok()
                .filter(|path| !path.as_os_str().is_empty());
            let task = module_relative
                .map(|path| {
                    let project = path
                        .components()
                        .filter_map(|component| match component {
                            Component::Normal(value) => Some(value.to_string_lossy()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(":");
                    format!(":{project}:taomniRun")
                })
                .unwrap_or_else(|| "taomniRun".into());
            let args = vec![
                "--console=plain".into(),
                "-I".into(),
                path_to_string(&init_script),
                format!("-PtaomniMainClass={main_class}"),
                task.clone(),
            ];
            let command = format!(
                "{runner} --console=plain -I {} -PtaomniMainClass={} {}",
                shell_quote(&path_to_string(&init_script)),
                shell_quote(&main_class),
                shell_quote(&task),
            );
            (
                command,
                path_to_string(&invocation_root),
                relative_path(workspace_root, &build_dir).unwrap_or_else(|_| ".".into()),
                "gradle",
                resolution.execution_owned(args),
                None,
            )
        }
        JavaBuildSystem::SourceFile => {
            let file_path = path_to_string(source_file);
            (
                format!("java {}", shell_quote(&file_path)),
                path_to_string(workspace_root),
                ".".into(),
                "source-file",
                WorkspaceTaskExecution {
                    executable: "java".into(),
                    args: vec![file_path],
                    source: "path".into(),
                    error: None,
                },
                None,
            )
        }
    };
    let module_path = if module_path.is_empty() {
        ".".into()
    } else {
        module_path
    };
    Ok(JavaRunTarget {
        id: format!("java-main:{relative_file}"),
        label: main_class.clone(),
        main_class,
        file_path: path_to_string(source_file),
        command,
        cwd,
        build_system: build_system_name.into(),
        module_path,
        execution,
        environment,
    })
}

pub(super) fn detect_java_run_targets(
    root: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Result<Vec<JavaRunTarget>, String> {
    let mut files = Vec::new();
    collect_workspace_files(
        root,
        root,
        0,
        JAVA_RUN_SCAN_MAX_DEPTH,
        JAVA_RUN_SCAN_MAX_FILES,
        &mut files,
    )?;
    let mut targets = Vec::new();
    for entry in files {
        if !entry.path.to_ascii_lowercase().ends_with(".java")
            || entry
                .path
                .split(['/', '\\'])
                .any(|segment| segment.eq_ignore_ascii_case("test"))
        {
            continue;
        }
        let source_file = root.join(&entry.path);
        match java_run_target_for_path(root, &source_file, tool_config) {
            Ok(target) => targets.push(target),
            Err(error) if error.starts_with("No `static void main") => {}
            Err(error) if error.starts_with("Java source is too large") => {}
            Err(error) => return Err(error),
        }
    }
    targets.sort_by(|left, right| {
        left.main_class
            .to_ascii_lowercase()
            .cmp(&right.main_class.to_ascii_lowercase())
            .then_with(|| left.file_path.cmp(&right.file_path))
    });
    Ok(targets)
}
