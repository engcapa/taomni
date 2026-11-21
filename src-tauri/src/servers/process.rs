//! Adapt shared daemon supervision to the desktop server log and status.

use std::sync::Arc;

use super::engine::{ServerCtx, ServerStarted};

#[allow(dead_code)]
pub async fn spawn_supervised(
    ctx: ServerCtx,
    program: &str,
    args: Vec<String>,
) -> Result<ServerStarted, String> {
    let log = ctx.log;
    let started = taomni_server_process::spawn_supervised(
        program,
        args,
        ctx.cancel,
        Arc::new(move |line| log.line(line)),
    )
    .await?;
    Ok(ServerStarted {
        pid: started.pid,
        task: started.task,
    })
}
