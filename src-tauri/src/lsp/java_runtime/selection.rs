use super::probe::java_major_version;
use crate::lsp::configuration_state::CONFIGURED_JAVA_HOME;
use crate::lsp::limits::JDTLS_MIN_JAVA_MAJOR;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;

pub(in crate::lsp) fn configured_java_home_lock() -> &'static StdMutex<Option<PathBuf>> {
    CONFIGURED_JAVA_HOME.get_or_init(|| StdMutex::new(None))
}

/// Store the Settings-configured JDK path (or clear with `None`).
pub(in crate::lsp) fn set_configured_java_home(java_home: Option<&str>) {
    let path = java_home
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    if let Ok(mut guard) = configured_java_home_lock().lock() {
        *guard = path;
    }
}

pub(in crate::lsp) fn get_configured_java_home() -> Option<PathBuf> {
    configured_java_home_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Expand a user/env path that may be a JDK home, `bin/`, or the `java` binary.
pub(in crate::lsp) fn resolve_java_binary_from_user_path(path: &Path) -> Option<PathBuf> {
    let bin_name = if cfg!(windows) { "java.exe" } else { "java" };
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if !path.is_dir() {
        return None;
    }
    let direct = path.join(bin_name);
    if direct.is_file() {
        return Some(direct);
    }
    let in_bin = path.join("bin").join(bin_name);
    if in_bin.is_file() {
        return Some(in_bin);
    }
    // macOS `.jdk` bundles: Contents/Home/bin/java
    let mac = path
        .join("Contents")
        .join("Home")
        .join("bin")
        .join(bin_name);
    if mac.is_file() {
        return Some(mac);
    }
    None
}

pub(in crate::lsp) fn java_home_from_binary(java: &Path) -> Option<PathBuf> {
    let parent = java.parent()?;
    if parent
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
    {
        return parent.parent().map(|p| p.to_path_buf());
    }
    Some(parent.to_path_buf())
}

pub(in crate::lsp) fn push_java_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.iter().any(|c| c == &path) {
        candidates.push(path);
    }
}

/// Pick a Java executable for jdtls, preferring the highest major >= 21.
/// Order: configured Settings path → JAVA_HOME → PATH → common install layouts.
pub(in crate::lsp) fn resolve_java_for_jdtls() -> Result<(PathBuf, u32), String> {
    resolve_java_for_jdtls_with_sdk(None, None)
}

/// Resolve the JVM that runs JDT LS. The legacy Language Servers override is
/// retained as the highest-precedence migration path; otherwise an explicit
/// workspace tooling-JDK binding wins over process JAVA_HOME/PATH discovery.
pub(in crate::lsp) fn resolve_java_for_jdtls_with_sdk(
    tooling_java_home: Option<&Path>,
    tooling_java_error: Option<&str>,
) -> Result<(PathBuf, u32), String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let configured_java_home = get_configured_java_home();
    if let Some(configured) = configured_java_home.as_ref() {
        if let Some(bin) = resolve_java_binary_from_user_path(&configured) {
            push_java_candidate(&mut candidates, bin);
        } else {
            return Err(format!(
                "configured Java runtime path is invalid: {} (expected JDK home or java binary, JDK {JDTLS_MIN_JAVA_MAJOR}+)",
                configured.display()
            ));
        }
    } else {
        if let Some(error) = tooling_java_error {
            return Err(error.to_string());
        }
        if let Some(tooling) = tooling_java_home {
            if let Some(bin) = resolve_java_binary_from_user_path(tooling) {
                push_java_candidate(&mut candidates, bin);
            } else {
                return Err(format!(
                    "workspace tooling JDK path is invalid: {} (expected JDK home or java binary, JDK {JDTLS_MIN_JAVA_MAJOR}+)",
                    tooling.display()
                ));
            }
        }
    }

    if let Ok(home) = std::env::var("JAVA_HOME") {
        if let Some(bin) = resolve_java_binary_from_user_path(Path::new(&home)) {
            push_java_candidate(&mut candidates, bin);
        }
    }
    if let Ok(path) = which::which("java") {
        push_java_candidate(&mut candidates, path);
    }
    // GUI-launched apps sometimes inherit a PATH that lacks the JDK even when
    // an interactive shell sees it. Probe common install layouts.
    #[cfg(windows)]
    {
        for base in [
            std::env::var_os("ProgramFiles"),
            std::env::var_os("ProgramFiles(x86)"),
        ]
        .into_iter()
        .flatten()
        {
            for vendor in [
                "Java",
                "Eclipse Adoptium",
                "Microsoft",
                "Amazon Corretto",
                "Semeru",
            ] {
                let root = PathBuf::from(&base).join(vendor);
                if let Ok(entries) = std::fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("bin").join("java.exe");
                        if candidate.is_file() {
                            push_java_candidate(&mut candidates, candidate);
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        for dir in [
            "/usr/lib/jvm",
            "/Library/Java/JavaVirtualMachines",
            "/opt/homebrew/opt/openjdk/bin",
            "/usr/local/opt/openjdk/bin",
        ] {
            let root = Path::new(dir);
            if root.is_file() {
                push_java_candidate(&mut candidates, root.to_path_buf());
                continue;
            }
            if root.is_dir() && root.ends_with("bin") {
                let candidate = root.join("java");
                if candidate.is_file() {
                    push_java_candidate(&mut candidates, candidate);
                }
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    for rel in ["bin/java", "Contents/Home/bin/java"] {
                        let candidate = path.join(rel);
                        if candidate.is_file() {
                            push_java_candidate(&mut candidates, candidate);
                        }
                    }
                }
            }
        }
    }

    if candidates.is_empty() {
        return Err(format!(
            "java not found for jdtls; install JDK {JDTLS_MIN_JAVA_MAJOR}+ and set it in Settings → Language Servers, JAVA_HOME, or PATH"
        ));
    }

    // If the user configured a path, only evaluate that first candidate so a
    // wrong/old override cannot silently fall back to another JDK on PATH.
    let configured_only = configured_java_home.is_some() || tooling_java_home.is_some();
    let search: Vec<PathBuf> = if configured_only {
        candidates.into_iter().take(1).collect()
    } else {
        candidates
    };

    let mut best_ok: Option<(PathBuf, u32)> = None;
    let mut best_any: Option<(PathBuf, u32)> = None;
    let mut last_err = String::new();
    for path in search {
        match java_major_version(&path) {
            Ok(major) => {
                if major >= JDTLS_MIN_JAVA_MAJOR {
                    if best_ok.as_ref().map(|(_, m)| major > *m).unwrap_or(true) {
                        best_ok = Some((path.clone(), major));
                    }
                }
                if best_any.as_ref().map(|(_, m)| major > *m).unwrap_or(true) {
                    best_any = Some((path, major));
                }
            }
            Err(e) => last_err = e,
        }
    }

    if let Some(ok) = best_ok {
        return Ok(ok);
    }
    if let Some((path, major)) = best_any {
        return Err(format!(
            "jdtls requires Java {JDTLS_MIN_JAVA_MAJOR}+ (current Eclipse JDT LS); found Java {major} at {}. Install JDK {JDTLS_MIN_JAVA_MAJOR}+ and configure it in Settings → Language Servers (or JAVA_HOME)",
            path.display()
        ));
    }
    Err(if last_err.is_empty() {
        format!("could not determine Java version for jdtls; need JDK {JDTLS_MIN_JAVA_MAJOR}+")
    } else {
        last_err
    })
}
