//! Supervise an external binary as a "server", streaming its stdout+stderr to
//! the frontend as log lines. Reused by the `vnc`, `nfs` and `iperf` leaves
//! (which wrap system daemons / tools) rather than implementing a protocol
//! in-process.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::engine::{ServerCtx, ServerStarted};

/// Resolve `program` on `PATH`, spawn it with `args`, stream both stdout and
/// stderr to `ctx.log`, and return the OS pid plus a supervisor task.
///
/// The supervisor task exits when either the child process terminates or
/// `ctx.cancel` is cancelled (in which case the child is killed —
/// `kill_on_drop(true)` guarantees cleanup even on abrupt drops).
// Reused by the vnc/nfs/iperf leaves in the implementation phase.
#[allow(dead_code)]
pub async fn spawn_supervised(
    ctx: ServerCtx,
    program: &str,
    args: Vec<String>,
) -> Result<ServerStarted, String> {
    let resolved = which::which(program).map_err(|_| {
        format!("{program} not found in PATH — install it to use this server")
    })?;

    let mut child = Command::new(&resolved)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", resolved.display(), e))?;

    let pid = child.id();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Pump stdout lines.
    if let Some(stdout) = stdout {
        let log = ctx.log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log.line(line);
            }
        });
    }
    // Pump stderr lines.
    if let Some(stderr) = stderr {
        let log = ctx.log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log.line(line);
            }
        });
    }

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
    let task = tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                match status {
                    Ok(s) => log.line(format!("process exited: {}", s)),
                    Err(e) => log.line(format!("process wait error: {}", e)),
                }
            }
            _ = cancel.cancelled() => {
                // Ask the child to terminate; kill_on_drop handles the rest.
                let _ = child.kill().await;
                log.line("process stopped");
            }
        }
    });

    Ok(ServerStarted { pid, task })
}
