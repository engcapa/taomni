use super::scopes::has_scope_marker;
use super::scopes::should_skip_directory;
use regex::Regex;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;

pub(super) const MAX_STANDALONE_FILES: usize = 500;

pub(super) fn first_capture(contents: &str, patterns: &[&str]) -> Option<String> {
    patterns.iter().find_map(|pattern| {
        Regex::new(pattern)
            .ok()?
            .captures(contents)?
            .get(1)
            .map(|capture| capture.as_str().trim().to_string())
    })
}

pub(super) fn directory_has_extension(scope: &Path, extensions: &[&str]) -> bool {
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

pub(super) fn read_text(path: &Path, warnings: &mut Vec<String>) -> Option<String> {
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

pub(super) fn read_trimmed(path: &Path, warnings: &mut Vec<String>) -> Option<String> {
    read_text(path, warnings)
        .map(|contents| contents.trim().to_string())
        .filter(|contents| !contents.is_empty())
}

pub(super) fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(super) fn paths_equal(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        path_string(left).eq_ignore_ascii_case(&path_string(right))
    } else {
        left == right
    }
}

pub(super) fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
