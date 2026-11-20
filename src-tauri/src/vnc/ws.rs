//! Application-owned connection routing and native pointer integration.

use tokio_util::sync::CancellationToken;

use taomni_vnc_api::{
    ConnectionRequest,
    forward::{ForwardRoute, ForwardTaskGuard},
};
use taomni_vnc_engine::ws::{
    NativeInput, ProbeRequest, VncDialedTransport, native_pointer_sampler, probe_connection,
    spawn_relay,
};
pub use taomni_vnc_engine::ws::{VncControl, VncSession};

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
    input: ConnectionRequest,
    network: Option<NetworkSettings>,
    attempt: CancellationToken,
) -> Result<VncSession, String> {
    let transport = dial_vnc_transport(input.host.clone(), input.port, network);
    spawn_relay(
        input.into(),
        transport,
        NativeInput {
            pointer: native_pointer_sampler(std::process::id()),
            ..NativeInput::default()
        },
        attempt,
    )
    .await
}

pub(crate) async fn test_connection(
    input: ConnectionRequest,
    network: Option<NetworkSettings>,
) -> Result<String, String> {
    let dial = dial_vnc_transport(input.host.clone(), input.port, network);
    probe_connection(
        ProbeRequest {
            host: input.host,
            username: input.username,
            password: input.password,
            security_policy: input.security_policy,
            allow_unencrypted: input.allow_unencrypted,
        },
        dial,
        CancellationToken::new(),
    )
    .await
}
