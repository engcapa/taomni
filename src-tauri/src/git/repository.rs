use super::*;

pub(super) fn snapshot(root: &Path) -> Result<GitSnapshot, String> {
    ensure_repo(root)?;
    let status = run_git_in(Some(root), ["status", "--short", "--branch", "-uall"])?;
    let (current_branch, detached, changes) = parse_status(&status);
    let head_oid = run_git_in(Some(root), ["rev-parse", "--short", "HEAD"])
        .ok()
        .and_then(|s| non_empty_string(&s));
    let upstream = run_git_in(
        Some(root),
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .and_then(|s| non_empty_string(&s));
    let (ahead, behind) = ahead_behind(root, upstream.as_deref());
    Ok(GitSnapshot {
        repo_root: root.to_string_lossy().to_string(),
        current_branch,
        head_oid,
        detached,
        upstream,
        ahead,
        behind,
        changes,
        remotes: list_remotes(root)?,
        branches: list_branches(root)?,
        stashes: list_stashes(root)?,
        tags: list_tags(root).unwrap_or_default(),
        settings: load_settings(root),
    })
}

pub(super) fn probe_path(path: &str) -> Result<GitProbeResult, String> {
    let path_buf = git_cwd_path(path);
    if !git_available() {
        return Ok(GitProbeResult {
            path: path.to_string(),
            git_available: false,
            is_repo: false,
            repo_root: None,
            error: Some("git executable was not found".to_string()),
        });
    }

    match run_git_in(Some(&path_buf), ["rev-parse", "--show-toplevel"]) {
        Ok(root) => Ok(GitProbeResult {
            path: path.to_string(),
            git_available: true,
            is_repo: true,
            repo_root: non_empty_string(&root),
            error: None,
        }),
        Err(error) => Ok(GitProbeResult {
            path: path.to_string(),
            git_available: true,
            is_repo: false,
            repo_root: None,
            error: Some(error),
        }),
    }
}

pub(super) fn git_cwd_path(path: &str) -> PathBuf {
    PathBuf::from(normalize_windows_shell_path(path).unwrap_or_else(|| path.to_string()))
}

#[cfg(windows)]
pub(super) fn normalize_windows_shell_path(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }

    let drive_uri_path = path.as_bytes();
    if drive_uri_path.len() >= 3
        && drive_uri_path[0] == b'/'
        && drive_uri_path[2] == b':'
        && drive_uri_path[1].is_ascii_alphabetic()
    {
        let rest = match &path[3..] {
            "" => "/",
            rest => rest,
        };
        return Some(
            format!(
                "{}:{}",
                (drive_uri_path[1] as char).to_ascii_uppercase(),
                rest
            )
            .replace('/', "\\"),
        );
    }

    let mut parts = path.split('/');
    if parts.next() == Some("") {
        match (parts.next(), parts.next()) {
            (Some(drive), None) if is_single_drive_letter(drive) => {
                return Some(format!("{}:\\", drive.to_ascii_uppercase()));
            }
            (Some(drive), Some(rest)) if is_single_drive_letter(drive) => {
                let suffix = std::iter::once(rest)
                    .chain(parts)
                    .collect::<Vec<_>>()
                    .join("\\");
                return Some(format!("{}:\\{}", drive.to_ascii_uppercase(), suffix));
            }
            (Some("cygdrive"), Some(drive)) if is_single_drive_letter(drive) => {
                let suffix = parts.collect::<Vec<_>>().join("\\");
                return Some(if suffix.is_empty() {
                    format!("{}:\\", drive.to_ascii_uppercase())
                } else {
                    format!("{}:\\{}", drive.to_ascii_uppercase(), suffix)
                });
            }
            _ => {}
        }
    }

    None
}

#[cfg(not(windows))]
pub(super) fn normalize_windows_shell_path(_path: &str) -> Option<String> {
    None
}

#[cfg(windows)]
pub(super) fn is_single_drive_letter(value: &str) -> bool {
    value.len() == 1 && value.as_bytes()[0].is_ascii_alphabetic()
}

pub(super) fn git_available() -> bool {
    new_git_command()
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub(super) fn ensure_repo(root: &Path) -> Result<(), String> {
    run_git_in(Some(root), ["rev-parse", "--git-dir"]).map(|_| ())
}
