//! Route VNC connections through the verified module while the core owns networking.

use std::time::Duration;

use serde::de::DeserializeOwned;
use taomni_vnc_api::{
    ConnectionRequest, Started,
    forward::{ForwardRoute, ForwardTaskGuard},
};
use tokio_util::sync::CancellationToken;

use crate::{
    plugin::{LifecycleState, PluginRegistry},
    terminal::{network::NetworkSettings, ssh::build_ssh_transport},
};

use super::DesktopVncSession;

pub(crate) const SLUG: &str = "vnc-client";
const PROBE: &str = "vnc/test";
const START: &str = "vnc/start";

pub struct HostedSession {
    started: Started,
    closed: CancellationToken,
    forward: tokio::task::AbortHandle,
}

impl HostedSession {
    pub(super) fn endpoint(&self) -> (u16, &str) {
        (self.started.ws_port, &self.started.ws_token)
    }

    pub(super) fn closed(&self) -> &CancellationToken {
        &self.closed
    }

    pub(super) async fn close(self) {
        self.forward.abort();
        self.closed.cancelled().await;
    }
}

impl Drop for HostedSession {
    fn drop(&mut self) {
        self.forward.abort();
    }
}

fn require_host(registry: &PluginRegistry) -> Result<(), String> {
    let record = registry
        .get(SLUG)
        .ok_or_else(|| "VNC Client must be installed and enabled".to_string())?;
    if record.state != LifecycleState::Enabled {
        return Err("VNC Client must be installed and enabled".into());
    }
    if !record.manifest.commands.contains(PROBE) || !record.manifest.commands.contains(START) {
        return Err("Update the VNC Client module".into());
    }
    Ok(())
}

pub(super) async fn test_connection(
    registry: &PluginRegistry,
    mut request: ConnectionRequest,
    network: Option<NetworkSettings>,
) -> Result<String, String> {
    #[cfg(feature = "legacy-vnc-client")]
    if registry.get(SLUG).is_none() {
        return super::ws::test_connection(request, network).await;
    }
    require_host(registry)?;
    let (route, task) = open_route(&request.host, request.port, network).await?;
    let _forward = ForwardTaskGuard::new(Some(task));
    request.forward = Some(route);
    invoke(registry, PROBE, request, CancellationToken::new()).await
}

pub(super) async fn start_session(
    registry: &PluginRegistry,
    mut request: ConnectionRequest,
    network: Option<NetworkSettings>,
    attempt: CancellationToken,
) -> Result<DesktopVncSession, String> {
    #[cfg(feature = "legacy-vnc-client")]
    if registry.get(SLUG).is_none() {
        return super::ws::spawn_vnc_relay(request, network, attempt)
            .await
            .map(DesktopVncSession::Local);
    }
    require_host(registry)?;
    let (route, task) = tokio::select! {
        route = open_route(&request.host, request.port, network) => route?,
        _ = attempt.cancelled() => return Err(stopped()),
    };
    let mut task = ForwardTaskGuard::new(Some(task));
    request.forward = Some(route);
    let started = invoke(registry, START, request, attempt).await?;
    let closed = CancellationToken::new();
    let watcher = closed.clone();
    let task = task.take().expect("bound VNC bridge");
    let forward = task.abort_handle();
    tokio::spawn(async move {
        let _ = task.await;
        watcher.cancel();
    });
    Ok(DesktopVncSession::Module(HostedSession {
        started,
        closed,
        forward,
    }))
}

async fn open_route(
    host: &str,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<(ForwardRoute, tokio::task::JoinHandle<()>), String> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let upstream = build_ssh_transport(host, port, network.as_ref())
            .await
            .map_err(|error| format!("VNC TCP connection failed: {error}"))?;
        ForwardRoute::bind(upstream)
            .await
            .map_err(|error| format!("VNC forward failed: {error}"))
    })
    .await
    .map_err(|_| "VNC TCP connection timed out after 15 seconds".to_string())?
}

async fn invoke<T: DeserializeOwned>(
    registry: &PluginRegistry,
    method: &'static str,
    payload: ConnectionRequest,
    attempt: CancellationToken,
) -> Result<T, String> {
    if attempt.is_cancelled() {
        return Err(stopped());
    }
    let payload = serde_json::to_value(payload).map_err(|error| error.to_string())?;
    let owner = registry.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let request_id = id.clone();
    let request_attempt = attempt.clone();
    let request = tauri::async_runtime::spawn_blocking(move || {
        owner.invoke_cancellable(SLUG, method, payload, &request_id, || {
            request_attempt.is_cancelled()
        })
    });
    let response = tokio::select! {
        response = request => response.map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?,
        _ = attempt.cancelled() => {
            registry.cancel_request(SLUG, &id);
            return Err(stopped());
        }
    };
    if attempt.is_cancelled() {
        return Err(stopped());
    }
    serde_json::from_value::<Result<T, String>>(response).map_err(|error| error.to_string())?
}

fn stopped() -> String {
    "VNC connection attempt stopped by the user".into()
}
