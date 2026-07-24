//! PID selection for Linux app-mode capture.

use std::collections::BTreeSet;

use crate::sockscap::config::AppSelector;
use crate::sockscap::paths::paths_match_exe;
use crate::sockscap::process;

/// Whether a packet/process PID belongs to a resolved app-mode target set.
pub fn matches_target_pid(pid: u32, target_pids: &BTreeSet<u32>) -> bool {
    target_pids.contains(&pid)
}

/// Resolve configured executable selectors to the currently-running PIDs.
///
/// cgroups operate on PIDs, not executable paths. Resolving immediately before
/// rules are installed keeps the selected set deterministic and lets start fail
/// safely when the user picked an app that is no longer running.
pub fn resolve_target_pids(selectors: &[AppSelector]) -> Result<BTreeSet<u32>, String> {
    let paths: Vec<&str> = selectors
        .iter()
        .map(|selector| selector.path.trim())
        .filter(|path| !path.is_empty())
        .collect();
    if paths.is_empty() {
        return Err("App mode requires at least one application path".into());
    }

    let mut pids = BTreeSet::new();
    for process in process::list_processes()? {
        if process.path.is_empty() {
            continue;
        }
        if paths
            .iter()
            .any(|selector| selector_matches_process_path(&process.path, selector))
        {
            pids.insert(process.pid);
        }
    }

    if pids.is_empty() {
        return Err("None of the selected applications is currently running".into());
    }
    Ok(pids)
}

/// Linux `/proc/<pid>/exe` resolves symbolic links, while a configured app
/// path may still use the distro's launcher symlink (for example `/usr/bin/*`).
/// Match both the existing cross-platform normalized spelling and canonical
/// filesystem paths so app-mode does not silently omit the selected process.
fn selector_matches_process_path(process_path: &str, selector: &str) -> bool {
    if paths_match_exe(process_path, selector) {
        return true;
    }
    match (
        std::fs::canonicalize(process_path),
        std::fs::canonicalize(selector),
    ) {
        (Ok(process_path), Ok(selector)) => process_path == selector,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_target_pid() {
        let targets = BTreeSet::from([1234, 5678]);
        assert!(matches_target_pid(1234, &targets));
        assert!(!matches_target_pid(9012, &targets));
    }

    #[test]
    fn follows_launcher_symlinks_when_matching_paths() {
        let executable = std::env::current_exe().unwrap();
        assert!(selector_matches_process_path(
            executable.to_str().unwrap(),
            "/proc/self/exe"
        ));
    }
}
