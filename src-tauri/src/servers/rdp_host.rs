//! Forward requests and local consent notifications for the signed RDP host.

use std::{sync::Arc, time::Duration};

use serde_json::Value;
use taomni_server_process::{ServerConfig, rdp};

use crate::{
    plugin::PluginRegistry,
    servers::{
        engine::{ServerCtx, ServerStarted},
        process,
    },
};

use super::publish;

pub(super) async fn start(
    ctx: ServerCtx,
    config: ServerConfig,
    plugins: Arc<PluginRegistry>,
) -> Result<ServerStarted, String> {
    let request = serde_json::to_value(config).map_err(|error| error.to_string())?;
    let session: rdp::Session = process::invoke(&plugins, rdp::SLUG, rdp::START, request).await?;
    let pid = Some(session.pid);
    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let stopping = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => true,
                _ = interval.tick() => false,
            };
            let method = if stopping { rdp::STOP } else { rdp::STATUS };
            match process::invoke::<rdp::Status>(
                &plugins,
                rdp::SLUG,
                method,
                Value::String(session.id.clone()),
            )
            .await
            {
                Ok(status) => {
                    for line in status.logs {
                        ctx.log.line(line);
                    }
                    for event in status.events {
                        publish(&ctx.app, event);
                    }
                    if stopping || !status.running {
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
