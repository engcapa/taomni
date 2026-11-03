//! Git baseline and workspace preparation. Never writes to the submitted project.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub fn freeze_revision(project: &Path) -> Result<String, String> {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(project)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|_| "GIT_UNAVAILABLE")?;
    if !status.status.success() {
        return Err("GIT_REPOSITORY_REQUIRED".into());
    }
    if !status.stdout.is_empty() {
        return Err(
            "DIRTY_PROJECT: commit or explicitly snapshot changes before submitting development"
                .into(),
        );
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(project)
        .args(["rev-parse", "--verify", "HEAD^{commit}"])
        .output()
        .map_err(|_| "GIT_UNAVAILABLE")?;
    let revision = String::from_utf8(output.stdout).map_err(|_| "GIT_REVISION_UNAVAILABLE")?;
    let revision = revision.trim();
    if !output.status.success()
        || !matches!(revision.len(), 40 | 64)
        || !revision.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("GIT_REVISION_UNAVAILABLE: commit the initial project baseline".into());
    }
    Ok(revision.into())
}

pub async fn prepare(
    project: &str,
    root: &Path,
    id: &str,
    revision: &str,
    cancel: &CancellationToken,
) -> Result<PathBuf, String> {
    let target = root.join("worktrees").join(id);
    if uuid::Uuid::parse_str(id).is_err()
        || !matches!(revision.len(), 40 | 64)
        || !revision.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("INVALID_WORKSPACE_IDENTITY".into());
    }
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    std::fs::create_dir_all(target.parent().ok_or("WORKTREE_PATH")?)
        .map_err(|_| "WORKTREE_PATH")?;
    if target.symlink_metadata().is_ok() {
        return Err("WORKTREE_EXISTS: retained workspace cannot be overwritten".into());
    }
    // Git owns its metadata locks. A timeout or cancellation kills this bounded
    // child, retains partial metadata for inspection, and never auto-prunes it.
    let mut command = Command::new("git");
    command
        .args(["-C", project, "worktree", "add", "--detach"])
        .arg(&target)
        .arg(revision)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| "GIT_UNAVAILABLE")?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED".to_string()),
            result = child.wait() => result.map_err(|_| "GIT_UNAVAILABLE".into()),
        }
    })
    .await;
    let status = match result {
        Ok(Ok(status)) => status,
        other => {
            let _ = child.kill().await;
            child
                .wait()
                .await
                .map_err(|_| "WORKER_STOP_UNKNOWN: workspace preparation could not be reaped")?;
            return Err(other
                .err()
                .map(|_| "WORKTREE_TIMEOUT".into())
                .unwrap_or_else(|| "CANCELLED".into()));
        }
    };
    if !status.success() {
        return Err("WORKTREE_FAILED: Git could not create the isolated workspace".into());
    }
    std::fs::write(
        crate::orchestration::core::service::project_marker(&target),
        id,
    )
    .map_err(|_| "WORKTREE_MARKER_FAILED")?;
    Ok(target)
}
