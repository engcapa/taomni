//! Run a Local servers listener in its installed module host.

use std::{sync::Arc, time::Duration};

use taomni_server_process::local::{self, Kind};

use super::{
    ServerConfig, ServerType,
    engine::{ServerCtx, ServerStarted},
    process,
};
use crate::plugin::PluginRegistry;

pub(super) fn kind(server: ServerType) -> Option<Kind> {
    Some(match server {
        ServerType::Ssh => Kind::Ssh,
        ServerType::Ftp => Kind::Ftp,
        ServerType::Tftp => Kind::Tftp,
        ServerType::Http => Kind::Http,
        ServerType::Telnet => Kind::Telnet,
        ServerType::Nfs => Kind::Nfs,
        ServerType::Cron => Kind::Cron,
        ServerType::Iperf => Kind::Iperf,
        ServerType::Rdp | ServerType::Vnc => return None,
    })
}

pub(super) async fn start(
    plugins: Arc<PluginRegistry>,
    ctx: ServerCtx,
    kind: Kind,
    config: ServerConfig,
) -> Result<ServerStarted, String> {
    let request = serde_json::to_value(local::StartRequest { kind, config })
        .map_err(|error| error.to_string())?;
    let response: local::StartResponse =
        process::invoke(&plugins, local::SLUG, local::START, request).await?;
    for line in response.logs {
        ctx.log.line(line);
    }
    let session = response.outcome?;
    let pid = Some(session.pid);
    let request = serde_json::to_value(session).map_err(|error| error.to_string())?;
    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let stopping = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => true,
                _ = interval.tick() => false,
            };
            let method = if stopping { local::STOP } else { local::STATUS };
            match process::invoke::<local::Status>(&plugins, local::SLUG, method, request.clone())
                .await
            {
                Ok(status) => {
                    for line in status.logs {
                        ctx.log.line(line);
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
