use super::*;

pub(super) fn python_module_name(root: &Path, source: &Path) -> Option<String> {
    let relative = source.strip_prefix(root).ok()?;
    let mut parts = relative
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()?;
    let last = parts.pop()?;
    let stem = last.strip_suffix(".py")?;
    if stem != "__init__" {
        parts.push(stem);
    }
    let valid = Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").ok()?;
    (!parts.is_empty() && parts.iter().all(|part| valid.is_match(part))).then(|| parts.join("."))
}

pub(super) fn python_entry_code(value: &str) -> Option<String> {
    let (module, function) = value.split_once(':')?;
    let valid = Regex::new(r"^[A-Za-z_][A-Za-z0-9_.]*$").ok()?;
    if !valid.is_match(module) || !valid.is_match(function) {
        return None;
    }
    Some(format!(
        "from {module} import {function} as _taomni_entry; raise SystemExit(_taomni_entry())"
    ))
}

pub(super) fn add_python(
    builder: &mut ModelBuilder,
    manifest: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let contents = read_text(manifest)?;
    let parsed: toml::Value = toml::from_str(&contents)
        .map_err(|error| format!("parse {}: {error}", manifest.display()))?;
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("python", manifest, &["python"], "python");
    let python_candidates = if cfg!(windows) {
        &["python.exe", "python"] as &[&str]
    } else {
        &["python3", "python"]
    };
    let venv = if cfg!(windows) {
        root.join(".venv/Scripts/python.exe")
    } else {
        root.join(".venv/bin/python")
    };
    let python = resolve_tool(
        root,
        "python",
        "Python",
        configured_tool(config, "python"),
        &[],
        &[
            venv.to_str().unwrap_or("python"),
            python_candidates[0],
            python_candidates[1],
        ],
        "Create a workspace virtual environment or configure the Python interpreter.",
    );
    builder
        .tools
        .entry(format!("{}\0python", path_string(root)))
        .or_insert_with(|| python.clone());
    let debugpy = builder.tool(root, config, "debugpy", "debugpy adapter", &[], &["debugpy-adapter"], "Install debugpy in the selected environment (`python -m pip install debugpy`) or configure debugpy-adapter.");
    let mut build_ids = Vec::new();
    let has_build_system = parsed.get("build-system").is_some();
    if has_build_system {
        let build = builder.build(
            &project,
            "Build wheel and sdist",
            "build",
            command(&python, vec!["-m".to_string(), "build".to_string()], root),
        );
        build_ids.push(build);
    }
    if parsed
        .get("tool")
        .and_then(|value| value.get("pytest"))
        .is_some()
    {
        builder.build(
            &project,
            "Run tests",
            "test",
            command(&python, vec!["-m".to_string(), "pytest".to_string()], root),
        );
    }
    let tables = [
        parsed.get("project").and_then(|value| value.get("scripts")),
        parsed
            .get("tool")
            .and_then(|value| value.get("poetry"))
            .and_then(|value| value.get("scripts")),
    ];
    let mut seen = BTreeSet::new();
    for table in tables
        .into_iter()
        .flatten()
        .filter_map(toml::Value::as_table)
    {
        for (name, entry) in table {
            if !seen.insert(name.clone()) {
                continue;
            }
            let Some(value) = entry.as_str() else {
                continue;
            };
            let Some(code) = python_entry_code(value) else {
                continue;
            };
            builder.run(
                &project,
                &format!("Entry point: {name}"),
                "entry-point",
                command(&python, vec!["-c".to_string(), code], root),
                None,
                build_ids.clone(),
                None,
            );
        }
    }
    if let Some(active) = active_in_project(active_file, root, &["py", "pyw"]) {
        let source_file = Some(path_string(&active));
        let debug_id = builder.debug(
            &project,
            &format!("Debug {}", active.file_name().unwrap_or_default().to_string_lossy()),
            "python",
            &debugpy,
            build_ids.clone(),
            source_file.clone(),
            json!({ "name": "Python", "type": "python", "request": "launch", "program": path_string(&active), "cwd": project.root, "args": [], "justMyCode": true, "subProcess": false }),
            Some(json!({ "kind": "stdio", "args": [] })),
        );
        builder.run(
            &project,
            &format!(
                "Run {}",
                active.file_name().unwrap_or_default().to_string_lossy()
            ),
            "file",
            command(&python, vec![path_string(&active)], root),
            source_file.clone(),
            build_ids.clone(),
            Some(debug_id),
        );
        if let Some(module) = python_module_name(root, &active) {
            builder.run(
                &project,
                &format!("Run module {module}"),
                "module",
                command(&python, vec!["-m".to_string(), module], root),
                source_file,
                build_ids,
                None,
            );
        }
    }
    Ok(())
}
