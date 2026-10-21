use super::*;

pub(super) fn is_windows_batch(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

pub(super) fn plan_tool_launch(
    executable: &Path,
    args: &[String],
    platform: HostPlatform,
) -> ToolLaunchPlan {
    if platform == HostPlatform::Windows && is_windows_batch(executable) {
        let mut command_line = format!("\"{}\"", path_to_string(executable).replace('"', "\"\""));
        for arg in args {
            command_line.push(' ');
            command_line.push_str(&quote_windows_cmd_arg(arg));
        }
        ToolLaunchPlan {
            program: "cmd.exe".to_string(),
            args: vec!["/D".into(), "/S".into(), "/C".into(), command_line],
        }
    } else {
        ToolLaunchPlan {
            program: path_to_string(executable),
            args: args.to_vec(),
        }
    }
}

pub(super) fn quote_windows_cmd_arg(value: &str) -> String {
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || "&|<>()^\"".contains(character))
    {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

pub(super) fn push_task(
    tasks: &mut Vec<WorkspaceTask>,
    source: &str,
    label: impl Into<String>,
    command: impl Into<String>,
    cwd: &Path,
) {
    let label = label.into();
    tasks.push(WorkspaceTask {
        id: format!("{}:{}", source, label.to_lowercase().replace(' ', "-")),
        label,
        command: command.into(),
        cwd: path_to_string(cwd),
        source: source.to_string(),
        module_path: None,
        execution: None,
        environment: None,
    });
}

pub(super) fn push_tool_task(
    tasks: &mut Vec<WorkspaceTask>,
    source: &str,
    label: &str,
    resolution: &ToolResolution,
    cwd: &Path,
) {
    let runner = resolution.task_runner(HostPlatform::current());
    push_task(tasks, source, label, format!("{runner} {label}"), cwd);
    if let Some(task) = tasks.last_mut() {
        task.execution = Some(resolution.execution(&[label]));
    }
}

pub(super) fn parse_named_targets(contents: &str) -> Vec<String> {
    let mut targets = Vec::new();
    for line in contents.lines() {
        if line.starts_with(char::is_whitespace) || line.starts_with('#') {
            continue;
        }
        let Some((candidate, _)) = line.split_once(':') else {
            continue;
        };
        let candidate = candidate.trim();
        if candidate.is_empty()
            || candidate.contains(['=', '%', '$'])
            || candidate.split_whitespace().count() != 1
        {
            continue;
        }
        if !targets.iter().any(|target| target == candidate) {
            targets.push(candidate.to_string());
        }
        if targets.len() >= 50 {
            break;
        }
    }
    targets
}

pub(super) fn wrapper_command_for(path: &Path, platform: HostPlatform) -> String {
    let quoted = shell_quote_for(&path_to_string(path), platform);
    if platform == HostPlatform::Windows {
        format!("& {quoted}")
    } else {
        quoted
    }
}

pub(super) fn shell_quote_for(value: &str, platform: HostPlatform) -> String {
    if platform == HostPlatform::Windows {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

pub(super) fn find_on_path(
    command: &str,
    path: Option<&OsStr>,
    platform: HostPlatform,
) -> Option<PathBuf> {
    let path = path?;
    let names: Vec<String> = if platform == HostPlatform::Windows {
        if Path::new(command).extension().is_some() {
            vec![command.to_string()]
        } else {
            vec![
                format!("{command}.exe"),
                format!("{command}.cmd"),
                format!("{command}.bat"),
                command.to_string(),
            ]
        }
    } else {
        vec![command.to_string()]
    };
    std::env::split_paths(path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| fs::canonicalize(&candidate).ok().or(Some(candidate)))
}

pub(super) fn resolve_configured_executable(
    configured: &str,
    workspace_root: &Path,
    path: Option<&OsStr>,
    platform: HostPlatform,
) -> Option<PathBuf> {
    let configured_path = Path::new(configured);
    if configured_path.is_absolute()
        || configured_path.components().count() > 1
        || configured.contains(['/', '\\'])
    {
        let candidate = if configured_path.is_absolute() {
            configured_path.to_path_buf()
        } else {
            workspace_root.join(configured_path)
        };
        return candidate
            .is_file()
            .then(|| fs::canonicalize(&candidate).unwrap_or(candidate));
    }
    find_on_path(configured, path, platform)
}

pub(super) fn resolve_build_tool_with_path(
    build_dir: &Path,
    workspace_root: &Path,
    tool: BuildTool,
    config: Option<&WorkspaceToolConfig>,
    platform: HostPlatform,
    path: Option<&OsStr>,
) -> ToolResolution {
    let mut current = Some(build_dir);
    while let Some(directory) = current {
        for name in tool.wrapper_names(platform) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                let executable = fs::canonicalize(&candidate).unwrap_or(candidate);
                return ToolResolution {
                    tool,
                    executable,
                    source: ToolSource::Wrapper,
                    available: true,
                    diagnostic: None,
                };
            }
        }
        if directory == workspace_root {
            break;
        }
        current = directory
            .parent()
            .filter(|parent| parent.starts_with(workspace_root));
    }

    if let Some(configured) = tool.configured(config) {
        if let Some(executable) =
            resolve_configured_executable(configured, workspace_root, path, platform)
        {
            return ToolResolution {
                tool,
                executable,
                source: ToolSource::Configured,
                available: true,
                diagnostic: None,
            };
        }
        return ToolResolution {
            tool,
            executable: PathBuf::from(configured),
            source: ToolSource::Configured,
            available: false,
            diagnostic: Some(format!(
                "Configured {} executable was not found: {configured}. Add a project wrapper, correct the configured path, or put `{}` on PATH.",
                tool.name(),
                tool.path_command()
            )),
        };
    }

    if let Some(executable) = find_on_path(tool.path_command(), path, platform) {
        return ToolResolution {
            tool,
            executable,
            source: ToolSource::Path,
            available: true,
            diagnostic: None,
        };
    }

    ToolResolution {
        tool,
        executable: PathBuf::from(tool.path_command()),
        source: ToolSource::Path,
        available: false,
        diagnostic: Some(format!(
            "{} executable was not found. Add a project wrapper ({}), configure an executable override, or put `{}` on PATH.",
            tool.name(),
            tool.wrapper_names(platform).join(" or "),
            tool.path_command()
        )),
    }
}

pub(super) fn resolve_build_tool(
    build_dir: &Path,
    workspace_root: &Path,
    tool: BuildTool,
    config: Option<&WorkspaceToolConfig>,
) -> ToolResolution {
    resolve_build_tool_with_path(
        build_dir,
        workspace_root,
        tool,
        config,
        HostPlatform::current(),
        std::env::var_os("PATH").as_deref(),
    )
}

/// Like [`resolve_build_tool`] but searches an explicit `PATH` for the global
/// (last-tier) fallback — used when spawning a build tool directly so the lookup
/// matches the SDK-enhanced environment the process will actually run with.
pub(super) fn resolve_build_tool_on_path(
    build_dir: &Path,
    workspace_root: &Path,
    tool: BuildTool,
    config: Option<&WorkspaceToolConfig>,
    path: Option<&OsStr>,
) -> ToolResolution {
    resolve_build_tool_with_path(
        build_dir,
        workspace_root,
        tool,
        config,
        HostPlatform::current(),
        path,
    )
}

/// Maven's default lifecycle phases most people run, in lifecycle order.
pub(super) const MAVEN_LIFECYCLE_PHASES: &[&str] = &[
    "clean", "validate", "compile", "test", "package", "verify", "install",
];

/// Gradle tasks common to the base/Java plugins (a fixed set — a live
/// `gradle tasks --all` enumeration would require spawning Gradle and is left as
/// a follow-up so this stays a pure, fast, offline function).
pub(super) const GRADLE_COMMON_TASKS: &[&str] = &[
    "clean", "classes", "build", "assemble", "check", "test", "jar",
];

pub(super) fn discover_java_build_directories(
    root: &Path,
) -> Result<Vec<(JavaBuildSystem, PathBuf, String)>, String> {
    let mut files = Vec::new();
    collect_workspace_files(root, root, 0, 10, 3_000, &mut files)?;
    let mut builds = Vec::new();
    for entry in files {
        let file_name = Path::new(&entry.path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let build_system = match file_name {
            "pom.xml" => JavaBuildSystem::Maven,
            "build.gradle" | "build.gradle.kts" => JavaBuildSystem::Gradle,
            _ => continue,
        };
        let build_dir = root
            .join(&entry.path)
            .parent()
            .unwrap_or(root)
            .to_path_buf();
        if builds
            .iter()
            .any(|(existing, dir, _)| *existing == build_system && *dir == build_dir)
        {
            continue;
        }
        let module_path = relative_path(root, &build_dir)?;
        builds.push((
            build_system,
            build_dir,
            if module_path.is_empty() {
                ".".into()
            } else {
                module_path
            },
        ));
    }
    builds.sort_by(|left, right| {
        left.2
            .split('/')
            .count()
            .cmp(&right.2.split('/').count())
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| format!("{:?}", left.0).cmp(&format!("{:?}", right.0)))
    });
    Ok(builds)
}

pub(super) fn build_task_id(source: &str, module_path: &str, task: &str) -> String {
    if module_path == "." {
        format!("{source}:{task}")
    } else {
        format!("{source}:{}:{task}", module_path.replace(['/', '\\'], ":"))
    }
}

pub(super) fn gradle_task_selector(invocation_root: &Path, build_dir: &Path, task: &str) -> String {
    let Ok(relative) = build_dir.strip_prefix(invocation_root) else {
        return task.into();
    };
    if relative.as_os_str().is_empty() {
        return task.into();
    }
    let project = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(":");
    format!(":{project}:{task}")
}

/// Build the grouped task tree: detected tasks bucketed by source (first-seen
/// order preserved), with Maven/Gradle enriched to their full lifecycle / common
/// tasks. Pure and offline — no build tool is spawned.
pub(super) fn build_workspace_task_tree(
    root: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Result<Vec<WorkspaceTaskGroup>, String> {
    let detected = detect_workspace_tasks(root, tool_config)?;
    let mut groups: Vec<WorkspaceTaskGroup> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let push = |groups: &mut Vec<WorkspaceTaskGroup>,
                index: &mut std::collections::HashMap<String, usize>,
                task: WorkspaceTask| {
        // Skip duplicate labels within a source (enrichment may overlap detection).
        if let Some(&i) = index.get(&task.source) {
            let group: &mut WorkspaceTaskGroup = &mut groups[i];
            if group.tasks.iter().any(|existing| existing.id == task.id) {
                return;
            }
            group.tasks.push(task);
        } else {
            index.insert(task.source.clone(), groups.len());
            groups.push(WorkspaceTaskGroup {
                source: task.source.clone(),
                tasks: vec![task],
            });
        }
    };

    // Maven / Gradle full lifecycle first (before the detected subset merges
    // in), including nested modules in a monorepo. Build commands use the
    // nearest parent wrapper and a module-qualified Gradle task selector.
    for (build_system, build_dir, module_path) in discover_java_build_directories(root)? {
        match build_system {
            JavaBuildSystem::Maven => {
                let resolution =
                    resolve_build_tool(&build_dir, root, BuildTool::Maven, tool_config);
                let runner = resolution.task_runner(HostPlatform::current());
                for phase in MAVEN_LIFECYCLE_PHASES {
                    push(
                        &mut groups,
                        &mut index,
                        WorkspaceTask {
                            id: build_task_id("Maven", &module_path, phase),
                            label: (*phase).to_string(),
                            command: format!("{runner} {phase}"),
                            cwd: path_to_string(&build_dir),
                            source: "Maven".into(),
                            module_path: Some(module_path.clone()),
                            execution: Some(resolution.execution(&[phase])),
                            environment: None,
                        },
                    );
                }
                push(
                    &mut groups,
                    &mut index,
                    WorkspaceTask {
                        id: build_task_id("Maven", &module_path, "rebuild"),
                        label: "rebuild".into(),
                        command: format!("{runner} clean compile"),
                        cwd: path_to_string(&build_dir),
                        source: "Maven".into(),
                        module_path: Some(module_path),
                        execution: Some(resolution.execution(&["clean", "compile"])),
                        environment: None,
                    },
                );
            }
            JavaBuildSystem::Gradle => {
                let invocation_root = gradle_invocation_root(root, &build_dir);
                let resolution =
                    resolve_build_tool(&invocation_root, root, BuildTool::Gradle, tool_config);
                let runner = resolution.task_runner(HostPlatform::current());
                for task in GRADLE_COMMON_TASKS {
                    let selector = gradle_task_selector(&invocation_root, &build_dir, task);
                    push(
                        &mut groups,
                        &mut index,
                        WorkspaceTask {
                            id: build_task_id("Gradle", &module_path, task),
                            label: (*task).to_string(),
                            command: format!("{runner} {}", shell_quote(&selector)),
                            cwd: path_to_string(&invocation_root),
                            source: "Gradle".into(),
                            module_path: Some(module_path.clone()),
                            execution: Some(resolution.execution(&[&selector])),
                            environment: None,
                        },
                    );
                }
                let clean = gradle_task_selector(&invocation_root, &build_dir, "clean");
                let classes = gradle_task_selector(&invocation_root, &build_dir, "classes");
                push(
                    &mut groups,
                    &mut index,
                    WorkspaceTask {
                        id: build_task_id("Gradle", &module_path, "rebuild"),
                        label: "rebuild".into(),
                        command: format!(
                            "{runner} {} {}",
                            shell_quote(&clean),
                            shell_quote(&classes)
                        ),
                        cwd: path_to_string(&invocation_root),
                        source: "Gradle".into(),
                        module_path: Some(module_path),
                        execution: Some(resolution.execution(&[&clean, &classes])),
                        environment: None,
                    },
                );
            }
            JavaBuildSystem::SourceFile => {}
        }
    }

    for task in detected {
        push(&mut groups, &mut index, task);
    }
    Ok(groups)
}

pub(super) fn detect_workspace_tasks(
    root: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Result<Vec<WorkspaceTask>, String> {
    let mut tasks = Vec::new();

    let package_json = root.join("package.json");
    if package_json.is_file() {
        let contents = fs::read_to_string(&package_json)
            .map_err(|e| format!("read {}: {e}", package_json.display()))?;
        let package: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|e| format!("parse {}: {e}", package_json.display()))?;
        let manager = if root.join("pnpm-lock.yaml").is_file() {
            "pnpm"
        } else if root.join("yarn.lock").is_file() {
            "yarn"
        } else {
            "npm"
        };
        if let Some(scripts) = package
            .get("scripts")
            .and_then(serde_json::Value::as_object)
        {
            let mut names: Vec<_> = scripts.keys().cloned().collect();
            names.sort();
            for name in names {
                push_task(
                    &mut tasks,
                    "package.json",
                    name.clone(),
                    format!("{manager} run {name}"),
                    root,
                );
            }
        }
    }

    if root.join("Cargo.toml").is_file() {
        for (label, command) in [
            ("build", "cargo build"),
            ("test", "cargo test"),
            ("run", "cargo run"),
            ("clippy", "cargo clippy"),
        ] {
            push_task(&mut tasks, "Cargo.toml", label, command, root);
        }
    }

    for (file_name, runner) in [
        ("Makefile", "make"),
        ("makefile", "make"),
        ("justfile", "just"),
    ] {
        let path = root.join(file_name);
        if !path.is_file() {
            continue;
        }
        let contents =
            fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        for target in parse_named_targets(&contents) {
            push_task(
                &mut tasks,
                file_name,
                target.clone(),
                format!("{runner} {target}"),
                root,
            );
        }
        if file_name.eq_ignore_ascii_case("makefile") {
            break;
        }
    }

    if root.join("build.gradle").is_file() || root.join("build.gradle.kts").is_file() {
        let resolution = resolve_build_tool(root, root, BuildTool::Gradle, tool_config);
        for target in ["build", "test"] {
            push_tool_task(&mut tasks, "Gradle", target, &resolution, root);
        }
    }

    if root.join("pom.xml").is_file() {
        let resolution = resolve_build_tool(root, root, BuildTool::Maven, tool_config);
        for target in ["package", "test"] {
            push_tool_task(&mut tasks, "Maven", target, &resolution, root);
        }
    }

    if root.join("go.mod").is_file() {
        for (label, command) in [
            ("build", "go build ./..."),
            ("test", "go test ./..."),
            ("vet", "go vet ./..."),
        ] {
            push_task(&mut tasks, "go.mod", label, command, root);
        }
    }

    let pyproject = root.join("pyproject.toml");
    if pyproject.is_file() {
        let contents = fs::read_to_string(&pyproject)
            .map_err(|e| format!("read {}: {e}", pyproject.display()))?;
        let project: toml::Value =
            toml::from_str(&contents).map_err(|e| format!("parse {}: {e}", pyproject.display()))?;
        let runner = if root.join("uv.lock").is_file() {
            "uv run"
        } else if project
            .get("tool")
            .and_then(|value| value.get("poetry"))
            .is_some()
        {
            "poetry run"
        } else {
            ""
        };
        let script_tables = [
            project
                .get("project")
                .and_then(|value| value.get("scripts")),
            project
                .get("tool")
                .and_then(|value| value.get("poetry"))
                .and_then(|value| value.get("scripts")),
        ];
        for table in script_tables.into_iter().flatten() {
            let Some(table) = table.as_table() else {
                continue;
            };
            let mut names: Vec<_> = table.keys().cloned().collect();
            names.sort();
            for name in names {
                if tasks
                    .iter()
                    .any(|task| task.source == "pyproject.toml" && task.label == name)
                {
                    continue;
                }
                let command = if runner.is_empty() {
                    name.clone()
                } else {
                    format!("{runner} {name}")
                };
                push_task(&mut tasks, "pyproject.toml", name, command, root);
            }
        }
    }

    Ok(tasks)
}
