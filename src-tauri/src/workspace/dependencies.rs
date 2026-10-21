use super::*;

/// A resolved dependency-tree node for the Build panel (M7 F-1). Nested by the
/// build tool's own tree output (Maven `dependency:tree` / Gradle `dependencies`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyNode {
    pub group: String,
    pub artifact: String,
    pub version: String,
    /// Maven scope (compile/test/…) or Gradle configuration hint; empty when unknown.
    pub scope: String,
    /// Version-arbitration note when the build tool bumped/omitted this node
    /// (e.g. Gradle `-> 2.0`, Maven verbose `omitted for conflict with 2.0`).
    pub conflict: Option<String>,
    pub children: Vec<DependencyNode>,
}

/// Parse `mvn dependency:tree` text output into a forest (the root project's
/// direct dependencies). Tree connectors are `+- ` / `\- `, each level indented
/// 3 columns (`|  ` / `   `). Coordinates are `group:artifact:packaging[:classifier]:version[:scope]`.
pub(super) fn parse_maven_dependency_tree(output: &str) -> Vec<DependencyNode> {
    let mut forest: Vec<DependencyNode> = Vec::new();
    // Index path to the current parent at each depth: `path[d]` is the child index
    // (within its parent's `children`) of the depth-(d+1) ancestor. Navigating this
    // path each insert keeps the tree safe (no raw pointers into reallocating Vecs).
    let mut path: Vec<usize> = Vec::new();
    let mut seen_root = false;

    for raw in output.lines() {
        let line = raw.strip_prefix("[INFO] ").unwrap_or(raw);
        let trimmed_end = line.trim_end();
        if trimmed_end.is_empty() {
            continue;
        }
        let connector = ["+- ", "\\- "]
            .iter()
            .filter_map(|marker| trimmed_end.find(*marker).map(|idx| (idx, marker.len())))
            .min_by_key(|(idx, _)| *idx);
        let (coord_start, depth) = match connector {
            Some((idx, marker_len)) => (idx + marker_len, idx / 3 + 1),
            None => {
                if seen_root || trimmed_end.matches(':').count() < 2 {
                    continue;
                }
                (0, 0)
            }
        };
        let Some(node) = parse_maven_coordinate(&trimmed_end[coord_start..]) else {
            continue;
        };
        if depth == 0 {
            // Root project line: its direct deps (depth 1) become the forest.
            seen_root = true;
            forest.clear();
            path.clear();
            continue;
        }
        insert_dependency_node(&mut forest, &mut path, depth, node);
    }
    forest
}

/// Insert `node` at `depth` (1 = top-level) into `forest`, using `path` as the
/// index trail to the current parent. `path` is truncated to `depth - 1` so the
/// node attaches under the correct ancestor, then extended with the new index.
pub(super) fn insert_dependency_node(
    forest: &mut Vec<DependencyNode>,
    path: &mut Vec<usize>,
    depth: usize,
    node: DependencyNode,
) {
    // Keep ancestors above the new node. `truncate` is a no-op when `level`
    // exceeds the path length (malformed deeper-by->1 jump → attach under deepest).
    path.truncate(depth - 1);
    if path.is_empty() {
        forest.push(node);
        path.push(forest.len() - 1);
        return;
    }
    // Walk the index path to the parent's children Vec.
    let mut children = &mut *forest;
    for &index in &path[..path.len() - 1] {
        children = &mut children[index].children;
    }
    let last = *path.last().unwrap();
    let siblings = &mut children[last].children;
    siblings.push(node);
    path.push(siblings.len() - 1);
}

/// Parse one Maven coordinate + optional conflict suffix into a leaf node.
pub(super) fn parse_maven_coordinate(text: &str) -> Option<DependencyNode> {
    let text = text.trim();
    // Split off a trailing `(...)` note (verbose conflict/version-managed marker).
    let (coord, conflict) = match text.split_once(" (") {
        Some((coord, note)) => (coord.trim(), Some(format!("({}", note.trim()))),
        None => (text, None),
    };
    let parts: Vec<&str> = coord.split(':').collect();
    let (group, artifact, version, scope) = match parts.as_slice() {
        // group:artifact:packaging:version:scope
        [g, a, _pkg, v, s] => (
            (*g).to_string(),
            (*a).to_string(),
            (*v).to_string(),
            (*s).to_string(),
        ),
        // group:artifact:packaging:classifier:version:scope
        [g, a, _pkg, _cls, v, s] => (
            (*g).to_string(),
            (*a).to_string(),
            (*v).to_string(),
            (*s).to_string(),
        ),
        // group:artifact:packaging:version (root project — no scope)
        [g, a, _pkg, v] => (
            (*g).to_string(),
            (*a).to_string(),
            (*v).to_string(),
            String::new(),
        ),
        _ => return None,
    };
    if group.is_empty() || artifact.is_empty() {
        return None;
    }
    Some(DependencyNode {
        group,
        artifact,
        version,
        scope,
        conflict,
        children: Vec::new(),
    })
}

/// Parse `gradle dependencies --configuration <cfg>` output into a forest. Tree
/// connectors are `+--- ` / `\--- ` (5 columns per level). A `req -> resolved`
/// suffix marks Gradle's version arbitration (recorded as a conflict note, with
/// the resolved version used). Trailing `(*)` / `(c)` / `(n)` markers are dropped.
pub(super) fn parse_gradle_dependencies(output: &str) -> Vec<DependencyNode> {
    let mut forest: Vec<DependencyNode> = Vec::new();
    let mut path: Vec<usize> = Vec::new();

    for raw in output.lines() {
        let line = raw.trim_end();
        let connector = ["+--- ", "\\--- "]
            .iter()
            .filter_map(|marker| line.find(*marker).map(|idx| (idx, marker.len())))
            .min_by_key(|(idx, _)| *idx);
        let Some((idx, marker_len)) = connector else {
            continue;
        };
        // Everything before the connector is `|    ` / `     ` indentation (5 cols).
        let depth = idx / 5 + 1;
        let Some(node) = parse_gradle_coordinate(&line[idx + marker_len..]) else {
            continue;
        };
        insert_dependency_node(&mut forest, &mut path, depth, node);
    }
    forest
}

/// Parse one Gradle coordinate line (already stripped of its connector).
pub(super) fn parse_gradle_coordinate(text: &str) -> Option<DependencyNode> {
    let mut text = text.trim();
    // Drop trailing status markers: (*) already shown, (c) constraint, (n) not resolved.
    for marker in [" (*)", " (c)", " (n)"] {
        if let Some(stripped) = text.strip_suffix(marker) {
            text = stripped.trim_end();
        }
    }
    if text.is_empty() {
        return None;
    }
    // Version arbitration: `group:artifact:requested -> resolved`.
    let (coord, conflict, resolved) = match text.split_once(" -> ") {
        Some((left, resolved)) => {
            let resolved = resolved.trim();
            (
                left.trim(),
                Some(format!("{} -> {resolved}", left.trim())),
                Some(resolved.to_string()),
            )
        }
        None => (text, None, None),
    };
    let parts: Vec<&str> = coord.split(':').collect();
    let (group, artifact, requested) = match parts.as_slice() {
        [g, a, v] => ((*g).to_string(), (*a).to_string(), (*v).to_string()),
        // A constraint line may be just `group:artifact` with the version arbitrated.
        [g, a] => ((*g).to_string(), (*a).to_string(), String::new()),
        _ => return None,
    };
    if group.is_empty() || artifact.is_empty() {
        return None;
    }
    Some(DependencyNode {
        group,
        artifact,
        version: resolved.unwrap_or(requested),
        scope: String::new(),
        conflict,
        children: Vec::new(),
    })
}

/// Suppress the transient console window when spawning `.cmd`/`.bat` wrappers
/// (mvnw.cmd / gradlew.bat) from the GUI process on Windows.
pub(super) fn no_console_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Dependency resolution can take a while on a cold Maven/Gradle cache; cap it.
pub(super) const DEPENDENCY_TREE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// Resolve the project dependency tree (M7 F-1) by spawning the build tool:
/// `mvn dependency:tree` for a pom.xml, `gradle dependencies` for a Gradle build.
/// Requires the tool (or its wrapper) to be available; returns a clear error if
/// the project is neither Maven nor Gradle, or the command fails / times out.
#[tauri::command]
pub async fn workspace_dependency_tree(
    repo_root: String,
    tool_config: Option<WorkspaceToolConfig>,
    state: State<'_, AppState>,
) -> Result<Vec<DependencyNode>, String> {
    let root = canonical_repo_root(&repo_root)?;
    let is_maven = root.join("pom.xml").is_file();
    let is_gradle = root.join("build.gradle").is_file() || root.join("build.gradle.kts").is_file();
    if !is_maven && !is_gradle {
        return Err(
            "No pom.xml or build.gradle found; dependency tree needs a Maven or Gradle project"
                .into(),
        );
    }

    // Resolve the workspace SDK environment so a directly-spawned build tool sees
    // the same JAVA_HOME/PATH the integrated terminal injects. Best-effort — fall
    // back to the inherited environment if resolution fails.
    let sdk_environment = state
        .workspace
        .sdk
        .resolve_environment(&root, &root)
        .await
        .ok();
    let process_path = std::env::var_os("PATH");
    let sdk_path: Option<OsString> = sdk_environment
        .as_ref()
        .and_then(|env| env.prepend_path(process_path.as_deref()));
    let lookup_path = sdk_path.as_deref().or(process_path.as_deref());

    // Maven is preferred when both exist (rare); its tree carries scopes. The
    // global (PATH) fallback tier searches the SDK-enhanced PATH.
    let (resolution, args): (ToolResolution, Vec<String>) = if is_maven {
        (
            resolve_build_tool_on_path(
                &root,
                &root,
                BuildTool::Maven,
                tool_config.as_ref(),
                lookup_path,
            ),
            vec!["-B".into(), "-q".into(), "dependency:tree".into()],
        )
    } else {
        (
            resolve_build_tool_on_path(
                &root,
                &root,
                BuildTool::Gradle,
                tool_config.as_ref(),
                lookup_path,
            ),
            vec![
                "-q".into(),
                "dependencies".into(),
                "--configuration".into(),
                "runtimeClasspath".into(),
            ],
        )
    };
    // Surface a clear diagnostic instead of spawning a runner we know is missing.
    resolution.require_available()?;

    // On Windows a `.cmd`/`.bat` wrapper cannot be launched directly by
    // CreateProcess and needs `cmd.exe /D /S /C`. `plan_tool_launch` returns the
    // correct program/args pair for the resolved executable.
    let plan = plan_tool_launch(&resolution.executable, &args, HostPlatform::current());
    let display = path_to_string(&resolution.executable);

    let mut command = tokio::process::Command::new(&plan.program);
    command
        .args(&plan.args)
        .current_dir(&root)
        .kill_on_drop(true);
    // Inject the SDK environment (JAVA_HOME etc. + prepended PATH) so the build
    // tool resolves the workspace's configured JDK, matching the terminal.
    if let Some(environment) = sdk_environment.as_ref() {
        for (key, value) in &environment.environment {
            command.env(key, value);
        }
        if let Some(path) = sdk_path.as_ref() {
            command.env("PATH", path);
        }
    }
    no_console_window(&mut command);

    let output = tokio::time::timeout(DEPENDENCY_TREE_TIMEOUT, command.output())
        .await
        .map_err(|_| "Dependency resolution timed out".to_string())?
        .map_err(|error| {
            format!("Failed to run `{display}` (is it installed / on PATH?): {error}")
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            stdout.trim()
        } else {
            detail
        };
        let snippet: String = detail.chars().take(600).collect();
        return Err(format!(
            "`{display}` exited with {}: {snippet}",
            output.status
        ));
    }

    let tree = if is_maven {
        parse_maven_dependency_tree(&stdout)
    } else {
        parse_gradle_dependencies(&stdout)
    };
    Ok(tree)
}
