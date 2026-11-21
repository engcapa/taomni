//! Core integration for RDP settings, consent prompts and app session events.

use super::{
    ServerConfig,
    engine::{ServerCtx, ServerStarted},
};
use std::sync::Arc;
use taomni_rdp_server_engine::DesktopEvent;
use tauri::{Emitter, Manager};

pub(crate) use taomni_rdp_server_engine::ApprovalBroker;
pub(crate) use taomni_server_process::system_rdp;

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let state = ctx.app.state::<crate::state::AppState>();
    let directory = crate::resolved_app_data_dir(&ctx.app)?.join("rdp-server");
    let approvals = state.legacy.servers.rdp_approvals.clone();
    let app = ctx.app.clone();
    let events = Arc::new(move |event| match event {
        DesktopEvent::ConnectionRequest(request) => app
            .emit_to("main", "server://rdp/connection-request", request)
            .is_ok(),
        DesktopEvent::Session(session) => app.emit("server://rdp/session", session).is_ok(),
    });
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
