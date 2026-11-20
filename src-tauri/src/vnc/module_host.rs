//! Route VNC connections through the verified module while the core owns networking.

use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use taomni_vnc_engine::ws::{
    ForwardTaskGuard, ProbeRequest, RelayRequest, forward::ForwardRoute, probe_connection,
};
use tokio_util::sync::CancellationToken;

use crate::{
    plugin::{LifecycleState, PluginRegistry},
    terminal::{network::NetworkSettings, ssh::build_ssh_transport},
};

use super::{
    policy::{VncClipboardPolicy, VncSecurityPolicy},
    quality::VncPictureQuality,
};

pub(crate) const SLUG: &str = "vnc-client";
const PROBE: &str = "vnc/test";
const START: &str = "vnc/start";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedEndpoint {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<zeroize::Zeroizing<String>>,
    security_policy: VncSecurityPolicy,
    allow_unencrypted: bool,
    forward: ForwardRoute,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedStart {
    #[serde(flatten)]
    endpoint: HostedEndpoint,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    picture_quality: VncPictureQuality,
    shared: bool,
}

#[derive(Deserialize)]
struct Started {
    ws_port: u16,
    ws_token: String,
}

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

pub(super) fn route_to_host(registry: &PluginRegistry) -> Result<bool, String> {
    let Some(record) = registry.get(SLUG) else {
        return Ok(false);
    };
    if record.state != LifecycleState::Enabled {
        return Err("VNC Client must be installed and enabled".into());
    }
    if !record.manifest.commands.contains(PROBE) || !record.manifest.commands.contains(START) {
        return Err("Update the VNC Client module".into());
    }
    Ok(true)
}

pub(super) async fn test_connection(
    registry: &PluginRegistry,
    request: ProbeRequest,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<String, String> {
    if !route_to_host(registry)? {
        let dial = super::ws::dial_vnc_transport(request.host.clone(), port, network);
        return probe_connection(request, dial, CancellationToken::new()).await;
    }
    let (endpoint, _forward) = open_route(request, port, network).await?;
    invoke(registry, PROBE, endpoint, CancellationToken::new()).await
}

pub(super) async fn start_session(
    registry: &PluginRegistry,
    request: RelayRequest,
    port: u16,
    network: Option<NetworkSettings>,
    attempt: CancellationToken,
) -> Result<HostedSession, String> {
    let view_only = request.view_only;
    let clipboard_policy = request.clipboard_policy;
    let picture_quality = request.options.picture_quality;
    let shared = request.options.shared;
    let (endpoint, mut forward) = tokio::select! {
        route = open_route(request.into(), port, network) => route?,
        _ = attempt.cancelled() => return Err(stopped()),
    };
    let started = invoke(
        registry,
        START,
        HostedStart {
            endpoint,
            view_only,
            clipboard_policy,
            picture_quality,
            shared,
        },
        attempt,
    )
    .await?;
    let closed = CancellationToken::new();
    let watcher = closed.clone();
    let task = forward.take().expect("bound VNC bridge");
    let forward = task.abort_handle();
    tokio::spawn(async move {
        let _ = task.await;
        watcher.cancel();
    });
    Ok(HostedSession {
        started,
        closed,
        forward,
    })
}

async fn open_route(
    request: ProbeRequest,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<(HostedEndpoint, ForwardTaskGuard), String> {
    let (forward, task) = tokio::time::timeout(Duration::from_secs(15), async {
        let upstream = build_ssh_transport(&request.host, port, network.as_ref())
            .await
            .map_err(|error| format!("VNC TCP connection failed: {error}"))?;
        ForwardRoute::bind(upstream)
            .await
            .map_err(|error| format!("VNC forward failed: {error}"))
    })
    .await
    .map_err(|_| "VNC TCP connection timed out after 15 seconds".to_string())??;
    let endpoint = HostedEndpoint {
        host: request.host,
        port,
        username: request.username,
        password: request.password,
        security_policy: request.security_policy,
        allow_unencrypted: request.allow_unencrypted,
        forward,
    };
    Ok((endpoint, ForwardTaskGuard::new(Some(task))))
}

async fn invoke<T: DeserializeOwned>(
    registry: &PluginRegistry,
    method: &'static str,
    payload: impl Serialize,
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
