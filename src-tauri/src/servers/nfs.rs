//! Adapt the Local servers registry to the NFS engine.

use super::{
    ServerConfig,
    engine::{ServerCtx, ServerStarted},
};

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    taomni_local_servers_engine::nfs::start(ctx.into(), config)
        .await
        .map(Into::into)
}
