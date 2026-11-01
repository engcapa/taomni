use crate::state::AppState;
use serde_json::{Value, json};
use std::{
    path::{Component, Path, PathBuf},
    process::Stdio,
};
use tokio::io::AsyncReadExt;
const TEXT_LIMIT: usize = 256 * 1024;

pub fn remember_root(state: &AppState, context: &crate::agent::context::AgentThreadContext) {
    // Remote cwd strings can coincidentally exist on this machine. Never grant
    // them local read access. Workspace context is explicitly local.
    let local = context
        .code_workspace
        .as_ref()
        .map(|w| w.repo_root.as_str())
        .filter(|p| !p.is_empty())
        .or_else(|| {
            (context.local_terminal_env.is_some()
                || (context.linked_session_id.is_none() && context.bound_session_id.is_none()))
            .then_some(context.cwd.as_deref())
            .flatten()
        });
    let root = local
        .and_then(|p| std::fs::canonicalize(p).ok())
        .filter(|p| p.is_dir() && super::file_policy::allowed_root(p));
    let mut roots = state
        .mobile
        .file_roots
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(root) = root {
        roots.insert(context.thread_id.clone(), root);
    } else if local.is_some()
        || context.bound_session_id.is_some()
        || context.linked_session_id.is_some()
    {
        // An explicit invalid/remote binding revokes access; context-free mobile
        // follow-ups retain the last desktop-granted local root.
        roots.remove(&context.thread_id);
    }
    state.mobile.roots_changed.notify_one();
}
fn task(id: &str) -> Result<&str, String> {
    id.strip_prefix("thread:").ok_or("diff_unavailable".into())
}
fn root(state: &AppState, id: &str) -> Result<PathBuf, String> {
    let root = state
        .mobile
        .file_roots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(task(id)?)
        .cloned()
        .ok_or("diff_unavailable")?;
    if !super::file_policy::allowed_root(&root)
        || state
            .mobile
            .profile_data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|data| root.starts_with(data))
    {
        return Err("path_denied".into());
    }
    Ok(root)
}
fn relative(path: &str) -> Result<&Path, String> {
    let p = Path::new(path);
    if path.is_empty()
        || path.contains(['\\', ':', '\0'])
        || p.is_absolute()
        || !super::file_policy::allowed_path(p)
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("path_denied".into());
    }
    Ok(p)
}
pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = relative(path)?;
    let root = root.canonicalize().map_err(|_| "diff_unavailable")?;
    let target = root
        .join(path)
        .canonicalize()
        .map_err(|_| "file_unavailable")?;
    if !super::file_policy::allowed_root(&root)
        || !target.starts_with(&root)
        || !super::file_policy::allowed_path(target.strip_prefix(&root).map_err(|_| "path_denied")?)
    {
        return Err("path_denied".into());
    }
    Ok(target)
}
async fn git(root: &Path, args: &[&str]) -> Result<(Vec<u8>, bool), String> {
    let mut command = tokio::process::Command::new("git");
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.quotepath=false",
            "-c",
            "core.fsmonitor=false",
            "-C",
        ])
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "diff_unavailable")?;
    let stdout = child.stdout.take().ok_or("diff_unavailable")?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut bytes = vec![];
        stdout
            .take((TEXT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "diff_unavailable")?;
        let truncated = bytes.len() > TEXT_LIMIT;
        if truncated {
            let _ = child.kill().await;
            bytes.truncate(TEXT_LIMIT);
        } else if !child
            .wait()
            .await
            .map_err(|_| "diff_unavailable")?
            .success()
        {
            return Err("diff_unavailable");
        }
        Ok((bytes, truncated))
    })
    .await
    .map_err(|_| "diff_unavailable")?;
    result.map_err(str::to_owned)
}
pub async fn changes(state: &AppState, id: &str) -> Result<Value, String> {
    let root = root(state, id)?;
    let (bytes, truncated) = git(
        &root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            "--",
            ".",
        ],
    )
    .await?;
    let (prefix, _) = git(&root, &["rev-parse", "--show-prefix"]).await?;
    let prefix = std::str::from_utf8(&prefix)
        .map_err(|_| "diff_unavailable")?
        .trim_end_matches('\n');
    let mut changes = vec![];
    for row in bytes.split(|b| *b == 0).filter(|r| r.len() >= 4) {
        let Ok(path) = std::str::from_utf8(&row[3..]) else {
            continue;
        };
        let Some(path) = path.strip_prefix(prefix) else {
            continue;
        };
        if relative(path).is_err() {
            continue;
        }
        changes.push(json!({"path":path,"change_kind":String::from_utf8_lossy(&row[..2]).trim(),"diff_available":&row[..2] != b"??"}));
    }
    Ok(json!({"changes":changes,"truncated":truncated}))
}
pub async fn file(state: &AppState, id: &str, path: &str) -> Result<Value, String> {
    let target = resolve(&root(state, id)?, path)?;
    if !tokio::fs::metadata(&target)
        .await
        .map_err(|_| "file_unavailable")?
        .is_file()
    {
        return Err("file_unavailable".into());
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    let file = options.open(target).await.map_err(|_| "file_unavailable")?;
    if !file
        .metadata()
        .await
        .map_err(|_| "file_unavailable")?
        .is_file()
    {
        return Err("file_unavailable".into());
    }
    let mut bytes = vec![];
    file.take((TEXT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "file_unavailable")?;
    if bytes.contains(&0) {
        return Err("binary_file".into());
    }
    let truncated = bytes.len() > TEXT_LIMIT;
    bytes.truncate(TEXT_LIMIT);
    Ok(json!({"path":path,"content":String::from_utf8_lossy(&bytes),"truncated":truncated}))
}
pub async fn diff(state: &AppState, id: &str, path: &str) -> Result<Value, String> {
    relative(path)?;
    let root = root(state, id)?;
    // Deleted paths still need a canonical parent; existing symlinks must be
    // checked before invoking Git, including staged and deleted worktree files.
    let candidate = root.join(path);
    if candidate.exists() || candidate.symlink_metadata().is_ok() {
        resolve(&root, path)?;
    } else {
        let parent = candidate
            .parent()
            .ok_or("path_denied")?
            .canonicalize()
            .map_err(|_| "path_denied")?;
        if !parent.starts_with(root.canonicalize().map_err(|_| "diff_unavailable")?) {
            return Err("path_denied".into());
        }
    }
    let (mut bytes, mut truncated) = git(
        &root,
        &["diff", "--no-ext-diff", "--no-textconv", "--", path],
    )
    .await?;
    let (staged, cut) = git(
        &root,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            path,
        ],
    )
    .await?;
    bytes.extend(staged);
    truncated |= cut || bytes.len() > TEXT_LIMIT;
    bytes.truncate(TEXT_LIMIT);
    if bytes.is_empty() {
        return Err("diff_unavailable".into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let hunks: Vec<_> = text
        .split_inclusive('\n')
        .fold(Vec::<String>::new(), |mut out, line| {
            if out.is_empty() || line.starts_with("@@") {
                out.push(String::new());
            }
            out.last_mut().unwrap().push_str(line);
            out
        });
    Ok(json!({"path":path,"hunks":hunks,"truncated":truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_boundary_rejects_traversal_absolute_and_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("ok"), "ok").unwrap();
        std::fs::write(dir.path().join("secret"), "secret").unwrap();
        assert!(resolve(&root, "ok").is_ok());
        for p in ["../secret", "/etc/passwd", "C:\\secret", "..\\secret"] {
            assert!(resolve(&root, p).is_err());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret"), root.join("link")).unwrap();
            assert_eq!(resolve(&root, "link").unwrap_err(), "path_denied");
        }
    }
}
