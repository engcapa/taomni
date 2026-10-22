use super::*;

pub(super) fn configured_tool<'a>(
    config: Option<&'a WorkspaceToolConfig>,
    id: &str,
) -> Option<&'a str> {
    let config = config?;
    let value = match id {
        "maven" => config.maven.as_deref(),
        "gradle" => config.gradle.as_deref(),
        "cargo" => config.cargo.as_deref(),
        "go" => config.go.as_deref(),
        "node" => config.node.as_deref(),
        "npm" => config.npm.as_deref(),
        "pnpm" => config.pnpm.as_deref(),
        "yarn" => config.yarn.as_deref(),
        "python" => config.python.as_deref(),
        "uv" => config.uv.as_deref(),
        "poetry" => config.poetry.as_deref(),
        "cmake" => config.cmake.as_deref(),
        "dotnet" => config.dotnet.as_deref(),
        "sbt" => config.sbt.as_deref(),
        "swift" => config.swift.as_deref(),
        "lldb-dap" => config.lldb_dap.as_deref(),
        "delve" => config.delve.as_deref(),
        "debugpy" => config.debugpy.as_deref(),
        "js-debug" => config.js_debug.as_deref(),
        "netcoredbg" => config.netcoredbg.as_deref(),
        _ => None,
    };
    value.map(str::trim).filter(|value| !value.is_empty())
}

pub(super) fn resolve_candidate(candidate: &str) -> Option<PathBuf> {
    let path = Path::new(candidate);
    if path.is_absolute() || candidate.contains('/') || candidate.contains('\\') {
        path.is_file().then(|| path.to_path_buf())
    } else {
        which::which(candidate).ok()
    }
}

pub(super) fn resolve_tool(
    root: &Path,
    id: &str,
    label: &str,
    configured: Option<&str>,
    wrappers: &[&str],
    candidates: &[&str],
    install_hint: &str,
) -> ToolProbe {
    for wrapper in wrappers {
        let path = root.join(wrapper);
        if path.is_file() {
            return ToolProbe {
                id: id.to_string(),
                label: label.to_string(),
                state: "available".to_string(),
                executable: Some(path_string(&path)),
                source: Some("wrapper".to_string()),
                install_hint: install_hint.to_string(),
            };
        }
    }
    if let Some(configured) = configured {
        return match resolve_candidate(configured) {
            Some(path) => ToolProbe {
                id: id.to_string(),
                label: label.to_string(),
                state: "available".to_string(),
                executable: Some(path_string(&path)),
                source: Some("configured".to_string()),
                install_hint: install_hint.to_string(),
            },
            None => ToolProbe {
                id: id.to_string(),
                label: label.to_string(),
                state: "missing".to_string(),
                executable: Some(configured.to_string()),
                source: Some("configured".to_string()),
                install_hint: format!(
                    "Configured executable `{configured}` was not found. {install_hint}"
                ),
            },
        };
    }
    for candidate in candidates {
        if let Some(path) = resolve_candidate(candidate) {
            return ToolProbe {
                id: id.to_string(),
                label: label.to_string(),
                state: "available".to_string(),
                executable: Some(path_string(&path)),
                source: Some("path".to_string()),
                install_hint: install_hint.to_string(),
            };
        }
    }
    ToolProbe {
        id: id.to_string(),
        label: label.to_string(),
        state: "missing".to_string(),
        executable: candidates.first().map(|value| (*value).to_string()),
        source: None,
        install_hint: install_hint.to_string(),
    }
}

pub(super) fn shell_preview(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "_+-./:=@\\".contains(ch))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

pub(super) fn command(tool: &ToolProbe, args: Vec<String>, cwd: &Path) -> ExecutionCommand {
    let executable = tool.executable.clone().unwrap_or_else(|| tool.id.clone());
    let display = std::iter::once(shell_preview(&executable))
        .chain(args.iter().map(|arg| shell_preview(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    ExecutionCommand {
        executable,
        args,
        cwd: path_string(cwd),
        env: BTreeMap::new(),
        display,
        source: tool.source.clone().unwrap_or_else(|| "path".to_string()),
        error: (tool.state != "available")
            .then(|| format!("{} is unavailable. {}", tool.label, tool.install_hint)),
    }
}
