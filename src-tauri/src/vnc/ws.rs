//! Application-owned connection routing and native pointer integration.

use tokio_util::sync::CancellationToken;

use taomni_vnc_engine::ws::{
    ForwardTaskGuard, RelayRequest, VncDialedTransport, forward::ForwardRoute, spawn_relay,
};
pub use taomni_vnc_engine::ws::{VNC_AUTH_TIMEOUT, VncControl, VncRelayOptions, VncSession};

use super::native_pointer::native_pointer_sampler;
use super::policy::{VncClipboardPolicy, VncSecurityPolicy};
use crate::terminal::network::NetworkSettings;
use crate::terminal::ssh::{SshTransport, build_ssh_transport};

const VNC_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) async fn dial_vnc_transport(
    host: String,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<VncDialedTransport, String> {
    tokio::time::timeout(VNC_CONNECT_TIMEOUT, async move {
        let upstream = build_ssh_transport(&host, port, network.as_ref())
            .await
            .map_err(|error| format!("VNC TCP connection failed: {error}"))?;
        // Proxied TCP streams can go straight to the existing desktop relay.
        // An SSH channel needs a local TCP bridge for the RFB TLS adapter.
        match upstream {
            SshTransport::Tcp(stream) => Ok(VncDialedTransport {
                stream,
                network_forward_task: None,
            }),
            SshTransport::Jump { .. } => {
                let (route, task) = ForwardRoute::bind(upstream)
                    .await
                    .map_err(|error| format!("VNC forward failed: {error}"))?;
                let mut forward_guard = ForwardTaskGuard::new(Some(task));
                let stream = route
                    .connect()
                    .await
                    .map_err(|error| format!("VNC TCP connection failed: {error}"))?;
                Ok(VncDialedTransport {
                    stream,
                    network_forward_task: forward_guard.take(),
                })
            }
        }
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
            password: password.map(zeroize::Zeroizing::new),
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
