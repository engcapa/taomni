//! Linux relay using the TUN primitive.

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::sockscap::relay::RelayContext;

pub async fn start_linux_relay(ctx: Arc<RwLock<RelayContext>>) -> Result<(), String> {
    let tun = crate::sockscap::capture::linux::tunnel::LinuxTUN::new()?;
    // Real smoltcp stack would run here with NAT
    tracing::info!("Linux relay ready (TUN + smoltcp NAT stub)");
    Ok(())
}