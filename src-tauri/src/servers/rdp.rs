//! Core integration for RDP settings, consent prompts and app session events.

use super::{
    ServerConfig,
    engine::{ServerCtx, ServerStarted},
};
use crate::{plugin::LifecycleState, state::AppState};
use taomni_server_process::rdp as contract;
use taomni_server_process::rdp::DesktopEvent;
use tauri::{AppHandle, Emitter, Manager};

#[path = "rdp_host.rs"]
mod host;

pub(crate) use taomni_server_process::system_rdp;

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let state = ctx.app.state::<AppState>();
    if let Some(record) = state.plugins.get(contract::SLUG) {
        if record.state != LifecycleState::Enabled {
            return Err("Enable the RDP Server module in Settings → Module Store.".into());
        }
        return host::start(ctx.clone(), config, state.plugins.clone()).await;
    }
    #[cfg(feature = "legacy-rdp-server")]
    {
        let directory = crate::resolved_app_data_dir(&ctx.app)?.join("rdp-server");
        let approvals = state.legacy.servers.rdp_approvals.clone();
        let app = ctx.app.clone();
        let events = std::sync::Arc::new(move |event| publish(&app, event));
        let task = taomni_rdp_server_engine::start(
            config,
            &directory,
            ctx.cancel,
            ctx.log.capture_log(),
            approvals,
            events,
        )
        .await?;
        Ok(ServerStarted { pid: None, task })
    }
    #[cfg(not(feature = "legacy-rdp-server"))]
    Err("Install the RDP Server module from Settings → Module Store.".into())
}

fn publish(app: &AppHandle, event: DesktopEvent) -> bool {
    match event {
        DesktopEvent::ConnectionRequest(request) => app
            .emit_to("main", "server://rdp/connection-request", request)
            .is_ok(),
        DesktopEvent::Session(session) => app.emit("server://rdp/session", session).is_ok(),
    }
}

pub(super) async fn resolve_approval(
    state: &AppState,
    request_id: String,
    approved: bool,
) -> Result<bool, String> {
    #[cfg(feature = "legacy-rdp-server")]
    if state
        .legacy
        .servers
        .rdp_approvals
        .resolve(&request_id, approved)
    {
        return Ok(true);
    }
    if !state
        .plugins
        .get(contract::SLUG)
        .is_some_and(|record| record.state == LifecycleState::Enabled)
    {
        return Ok(false);
    }
    let input = serde_json::to_value(contract::Approval {
        request_id,
        approved,
    })
    .map_err(|error| error.to_string())?;
    super::process::invoke(&state.plugins, contract::SLUG, contract::APPROVE, input).await
}
