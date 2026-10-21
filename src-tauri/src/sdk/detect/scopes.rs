use super::files::paths_equal;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;

pub(super) const MAX_SCAN_DEPTH: usize = 6;
pub(super) const MAX_SCAN_DIRECTORIES: usize = 1_000;

pub(super) fn collect_scope_directories(root: &Path) -> Vec<PathBuf> {
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

pub(super) fn has_scope_marker(directory: &Path) -> bool {
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

pub(super) fn has_gradle_marker(directory: &Path) -> bool {
    [
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
    ]
    .iter()
    .any(|name| directory.join(name).is_file())
}

pub(super) fn has_python_marker(directory: &Path) -> bool {
    [
        "pyproject.toml",
        "Pipfile",
        ".python-version",
        "runtime.txt",
    ]
    .iter()
    .any(|name| directory.join(name).is_file())
}

pub(super) fn should_skip_directory(path: &Path) -> bool {
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
