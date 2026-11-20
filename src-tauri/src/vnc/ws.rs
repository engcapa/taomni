//! Application-owned connection routing and native pointer integration.

use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use taomni_vnc_engine::ws::{ForwardTaskGuard, RelayRequest, VncDialedTransport, spawn_relay};
pub use taomni_vnc_engine::ws::{VNC_AUTH_TIMEOUT, VncControl, VncRelayOptions, VncSession};

use super::native_pointer::native_pointer_sampler;
use super::policy::{VncClipboardPolicy, VncSecurityPolicy};
use crate::terminal::network::NetworkSettings;

const VNC_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) async fn dial_vnc_transport(
    host: String,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<VncDialedTransport, String> {
    tokio::time::timeout(VNC_CONNECT_TIMEOUT, async move {
        let network_forward = match network.as_ref() {
            Some(settings) if settings.proxy_kind != "none" && !settings.proxy_kind.is_empty() => {
                Some(crate::database::forward::start(host.clone(), port, settings.clone()).await?)
            }
            _ => None,
        };
        let local_port = network_forward.as_ref().map(|forward| forward.local_port);
        let mut forward_guard = ForwardTaskGuard::new(network_forward.map(|forward| forward.task));
        let socket = match local_port {
            Some(local_port) => TcpStream::connect(("127.0.0.1", local_port))
                .await
                .map_err(|e| format!("VNC TCP connection failed: {e}"))?,
            None => crate::terminal::network::establish_transport(&host, port, network.as_ref())
                .await
                .map_err(|e| format!("VNC TCP connection failed: {e}"))?,
        };
        Ok(VncDialedTransport {
            stream: socket,
            network_forward_task: forward_guard.take(),
        })
    })
    .await
    .map_err(|_| "VNC TCP connection timed out after 15 seconds".to_string())?
}

pub async fn spawn_vnc_relay(
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    network: Option<NetworkSettings>,
    security_policy: VncSecurityPolicy,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    options: VncRelayOptions,
    attempt: CancellationToken,
) -> Result<VncSession, String> {
    let transport = dial_vnc_transport(host.clone(), port, network);
    spawn_relay(
        RelayRequest {
            host,
            username,
            password,
            security_policy,
            view_only,
            clipboard_policy,
            options,
        },
        transport,
        native_pointer_sampler(),
        attempt,
    )
    .await
}
