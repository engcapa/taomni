//! Adapt shared daemon supervision to the desktop server log and status.

use std::sync::Arc;

use super::engine::{ServerCtx, ServerStarted};
use crate::plugin::PluginRegistry;
use serde::de::DeserializeOwned;
use serde_json::Value;

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

pub(super) async fn invoke<T: DeserializeOwned>(
    plugins: &Arc<PluginRegistry>,
    slug: &'static str,
    method: &'static str,
    value: Value,
) -> Result<T, String> {
    let plugins = plugins.clone();
    let response = tokio::task::spawn_blocking(move || plugins.invoke(slug, method, value))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    serde_json::from_value(response).map_err(|error| format!("Invalid {slug} response: {error}"))
}
