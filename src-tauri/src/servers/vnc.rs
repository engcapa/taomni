//! Connect the Servers UI and its lifecycle to the platform VNC daemon.

use std::{sync::Arc, time::Duration};

use super::ServerConfig;
use super::engine::{ServerCtx, ServerStarted};
use crate::plugin::{LifecycleState, PluginRegistry};
use serde::de::DeserializeOwned;
use serde_json::Value;
use taomni_server_process::vnc;
use tauri::Manager;

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let options = vnc::Config {
        port: config.port,
        bind_address: config.bind_address.clone(),
        view_only: config.bool_field("viewOnly", false),
        shared_desktop: config.bool_field("sharedDesktop", true),
        password: config.str_field("password", "").to_owned(),
    };
    let plugins = ctx.app.state::<crate::state::AppState>().plugins.clone();
    match plugins.get(vnc::SLUG) {
        Some(record) if record.state == LifecycleState::Enabled => {
            start_installed(ctx, options, plugins).await
        }
        Some(_) => Err("Enable the VNC Server module in Settings → Module Store.".into()),
        None => Err("Install the VNC Server module from Settings → Module Store.".into()),
    }
}

async fn start_installed(
    ctx: ServerCtx,
    options: vnc::Config,
    plugins: Arc<PluginRegistry>,
) -> Result<ServerStarted, String> {
    let session: vnc::Session = call(
        &plugins,
        vnc::START,
        serde_json::to_value(options).map_err(|error| error.to_string())?,
    )
    .await?;
    let pid = session.pid;
    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        loop {
            let stop = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => true,
                _ = interval.tick() => false,
            };
            let method = if stop { vnc::STOP } else { vnc::STATUS };
            match call::<vnc::Status>(&plugins, method, Value::String(session.id.clone())).await {
                Ok(status) => {
                    for line in status.logs {
                        ctx.log.line(line);
                    }
                    if stop || !status.running {
                        break;
                    }
                }
                Err(error) => {
                    ctx.log.line(error);
                    break;
                }
            }
        }
    });
    Ok(ServerStarted { pid, task })
}

async fn call<T: DeserializeOwned>(
    plugins: &Arc<PluginRegistry>,
    method: &'static str,
    value: Value,
) -> Result<T, String> {
    let plugins = plugins.clone();
    let response = tokio::task::spawn_blocking(move || plugins.invoke(vnc::SLUG, method, value))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    serde_json::from_value(response)
        .map_err(|error| format!("Invalid VNC server response: {error}"))
}
