use crate::sdk::SdkInstallation;
use crate::sdk::SdkKind;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

pub(super) fn executable_directories<'a>(
    installations: impl Iterator<Item = &'a SdkInstallation>,
) -> Vec<String> {
    let mut directories = Vec::new();
    let mut seen = HashSet::new();
    for installation in installations {
        let candidates = if installation.executables.is_empty() {
            vec![Path::new(&installation.location).join(
                if cfg!(windows) && installation.kind == SdkKind::Python {
                    "Scripts"
                } else {
                    "bin"
                },
            )]
        } else {
            installation
                .executables
                .values()
                .filter_map(|executable| Path::new(executable).parent().map(Path::to_path_buf))
                .collect::<Vec<_>>()
        };
        for directory in candidates {
            let value = path_string(&directory);
            let key = path_key(&directory);
            if seen.insert(key) {
                directories.push(value);
            }
        }
    }
    directories
}

pub(super) fn is_python_environment(location: &str) -> bool {
    let path = Path::new(location);
    path.join("pyvenv.cfg").is_file() || path.join("conda-meta").is_dir()
}

pub(super) fn path_is_within(path: &Path, ancestor: &Path) -> bool {
    let path = canonical_or_original(path);
    let ancestor = canonical_or_original(ancestor);
    if cfg!(windows) {
        let path = path_string(&path).to_ascii_lowercase();
        let ancestor = path_string(&ancestor).to_ascii_lowercase();
        return path == ancestor
            || path
                .strip_prefix(&ancestor)
                .is_some_and(|suffix| suffix.starts_with(['/', '\\']));
    }
    path == ancestor || path.starts_with(ancestor)
}

pub(super) fn paths_equal(left: &str, right: &str) -> bool {
    let left = path_string(&canonical_or_original(Path::new(left)));
    let right = path_string(&canonical_or_original(Path::new(right)));
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

pub(super) fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(super) fn path_key(path: &Path) -> String {
    let value = path_string(&canonical_or_original(path));
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

pub(super) fn path_string(path: &Path) -> String {
    // Strip Windows `\\?\` verbatim prefixes (from `canonicalize`) so emitted
    // scope paths and PATH entries work with cmd.exe / batch launchers.
    super::super::strip_verbatim_prefix(&path.to_string_lossy())
}

/// An SDK's install location as a plain string for use as an environment value
/// (`JAVA_HOME`, `VIRTUAL_ENV`, …). Strips any verbatim prefix so batch
/// launchers resolving `%JAVA_HOME%\bin\java.exe` don't hit "path not found".
pub(super) fn sdk_home(installation: &SdkInstallation) -> String {
    super::super::strip_verbatim_prefix(&installation.location)
}

pub(super) fn normalize_inherited_home(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| super::super::strip_verbatim_prefix(value))
}
