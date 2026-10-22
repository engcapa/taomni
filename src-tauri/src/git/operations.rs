use super::*;

pub(super) fn git_path(root: &Path, name: &str) -> Option<PathBuf> {
    run_git_in(Some(root), ["rev-parse", "--git-path", name])
        .ok()
        .and_then(|s| non_empty_string(&s))
        .map(|p| {
            let pb = PathBuf::from(&p);
            if pb.is_absolute() { pb } else { root.join(pb) }
        })
}

/// Detect an in-progress operation that may be holding a conflict, so the UI can
/// label continue/abort correctly (a long-standing bug: it always said "cherry-pick").
pub(super) fn detect_operation(root: &Path) -> String {
    let exists = |name: &str| git_path(root, name).map(|p| p.exists()).unwrap_or(false);
    if exists("rebase-merge") || exists("rebase-apply") {
        "rebase".into()
    } else if exists("MERGE_HEAD") {
        "merge".into()
    } else if exists("CHERRY_PICK_HEAD") {
        "cherryPick".into()
    } else if exists("REVERT_HEAD") {
        "revert".into()
    } else {
        "none".into()
    }
}

/// Unmerged paths from the index. Uses plumbing (`ls-files --unmerged`)
/// because porcelain `git diff` refreshes and rewrites a stale `.git/index`
/// even with `GIT_OPTIONAL_LOCKS=0`, and this probe runs on every Git panel
/// refresh (ED-PARITY-008-A3: viewing is not a Git write).
pub(super) fn conflicted_paths(root: &Path) -> Vec<String> {
    let Ok(output) = run_git_in(Some(root), ["ls-files", "--unmerged", "-z"]) else {
        return Vec::new();
    };
    let mut paths: Vec<String> = Vec::new();
    // Each record is "<mode> <object> <stage>\t<path>" terminated by NUL.
    for record in output.split('\0') {
        let Some((_, path)) = record.split_once('\t') else {
            continue;
        };
        if !path.is_empty() && !paths.iter().any(|known| known == path) {
            paths.push(path.to_string());
        }
    }
    paths
}
