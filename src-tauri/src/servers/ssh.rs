//! Connect the Local servers registry to the SSH engine.

use super::{
    ServerConfig,
    engine::{ServerCtx, ServerStarted},
};

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let identity = crate::resolved_app_data_dir(&ctx.app)?.join("ssh-server");
    taomni_local_servers_engine::ssh::start(ctx.into(), config, &identity)
        .await
        .map(Into::into)
}
