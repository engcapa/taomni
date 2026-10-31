use super::server::Service;
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
        .filter(|p| p.is_dir());
    let mut roots = state.mobile.file_roots.lock().unwrap();
    if let Some(root) = root {
        roots.insert(context.thread_id.clone(), root);
    } else {
        roots.remove(&context.thread_id);
    }
    state.mobile.roots_changed.notify_one();
}
fn task(id: &str) -> Result<&str, String> {
    id.strip_prefix("thread:").ok_or("diff_unavailable".into())
}
fn root(state: &AppState, id: &str) -> Result<PathBuf, String> {
    state
        .mobile
        .file_roots
        .lock()
        .unwrap()
        .get(task(id)?)
        .cloned()
        .ok_or("diff_unavailable".into())
}
fn relative(path: &str) -> Result<&Path, String> {
    let p = Path::new(path);
    if path.is_empty()
        || path.contains(['\\', ':', '\0'])
        || p.is_absolute()
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
    if !target.starts_with(&root) {
        return Err("path_denied".into());
    }
    Ok(target)
}
async fn git(root: &Path, args: &[&str]) -> Result<(Vec<u8>, bool), String> {
    let mut child = tokio::process::Command::new("git")
        .args(["--no-pager", "-c", "core.quotepath=false", "-C"])
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
            "--untracked-files=normal",
        ],
    )
    .await?;
    let mut changes = vec![];
    for row in bytes.split(|b| *b == 0).filter(|r| r.len() >= 4) {
        let Ok(path) = std::str::from_utf8(&row[3..]) else {
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
    let file = tokio::fs::File::open(target)
        .await
        .map_err(|_| "file_unavailable")?;
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

/// Native filesystem notifications, independent of PTY and mobile page lifetime.
pub fn watch(service: Service) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use notify::{RecursiveMode, Watcher};
        let mut watches = std::collections::HashMap::new();
        loop {
            let roots = service.runtime.file_roots.lock().unwrap().clone();
            watches.retain(|id, (root, _)| roots.get(id) == Some(root));
            for (id, root) in roots {
                if watches.contains_key(&id) {
                    continue;
                }
                let events = service.runtime.events.clone();
                let task = format!("thread:{id}");
                let base = root.clone();
                let watcher = notify::recommended_watcher(
                    move |result: notify::Result<notify::Event>| match result {
                        Ok(event)
                            if event.kind.is_modify()
                                || event.kind.is_create()
                                || event.kind.is_remove() =>
                        {
                            for path in event.paths {
                                if let Ok(relative) = path.strip_prefix(&base) {
                                    if relative.components().any(|c| c.as_os_str() == ".git") {
                                        continue;
                                    }
                                    events.publish(json!({"type":"file_changed", "task_id":task,"path":relative.to_string_lossy(),"change_kind":"changed"}));
                                }
                            }
                        }
                        Err(_) => events.publish(json!({"type":"resync"})),
                        _ => {}
                    },
                );
                if let Ok(mut watcher) = watcher {
                    if watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
                        watches.insert(id, (root, watcher));
                    } else {
                        service.runtime.events.publish(json!({"type":"resync"}));
                    }
                }
            }
            tokio::select! { _ = service.cancel.cancelled() => break, _ = service.runtime.roots_changed.notified() => {} }
        }
    })
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
