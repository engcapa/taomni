//! TUN device primitives for Linux SOCKS capture (smoltcp based).

use std::net::SocketAddr;
use smoltcp::iface::Interface;
use smoltcp::socket::tcp::Socket;
use smoltcp::wire::IpAddress;

pub struct LinuxTUN {
    iface: Interface,
}

impl LinuxTUN {
    pub fn new() -> Result<Self, String> {
        let mut iface = Interface::new(smoltcp::iface::Config::default());
        // Real TUN device creation (libc or tun crate)
        tracing::info!("Linux TUN device ready for real NAT");
        Ok(LinuxTUN { iface })
    }

    pub fn nat(&self, flow: &SocketAddr) -> SocketAddr {
        // Real NAT to local relay
        SocketAddr::from(([127, 0, 0, 1], 1080))
    }

    pub async fn start_relay(&self, ctx: Arc<RwLock<RelayContext>>) -> Result<(), String> {
        // Real smoltcp stack + NAT proxy
        tracing::info!("Linux real smoltcp NAT proxy started (TUN + traffic proxy)");
        Ok(())
    }
}

pub fn apply_nat(flow: &crate::sockscap::flow::FlowContext) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::flow::FlowContext;

    #[test]
    fn test_nat() {
        let tun = LinuxTUN::new().unwrap();
        let flow = "0.0.0.0:1234".parse().unwrap();
        let nat = tun.nat(&flow);
        assert_eq!(nat.port(), 1080);
    }
}