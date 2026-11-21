use serde::{Serialize, de::DeserializeOwned};
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};
use taomni_rdp_client_api::{
    CLOSE, Connection, ConnectionTestResult, RdpOptions, SLUG, START, SessionId, Started, TEST,
};
use taomni_rdp_client_engine::transport::RdpConnector;

use crate::plugin::PluginRegistry;

pub(crate) struct ModuleSession {
    pub started: Started,
    pub route: Route,
}

pub(super) async fn bind_route(connector: RdpConnector) -> Result<(Route, Endpoint), String> {
    Route::bind(move || {
        let connect = connector.clone();
        async move {
            let stream = connect().await?;
            let address = stream.local_addr;
            Ok((stream, address))
        }
    })
    .await
    .map_err(|error| format!("RDP module route failed: {error}"))
}

pub(super) async fn start(
    registry: &PluginRegistry,
    request: Connection,
    route: Route,
) -> Result<ModuleSession, String> {
    let started = invoke::<Result<Started, String>>(registry, START, request).await??;
    Ok(ModuleSession { started, route })
}

pub(super) async fn test(
    registry: &PluginRegistry,
    request: Connection,
    _route: Route,
) -> Result<ConnectionTestResult, String> {
    invoke::<Result<ConnectionTestResult, String>>(registry, TEST, request).await?
}

pub(super) async fn close(registry: &PluginRegistry, session: ModuleSession) {
    drop(session.route);
    if let Some(record) = registry.get(SLUG)
        && record.state == crate::plugin::LifecycleState::Enabled
    {
        let _ = invoke::<bool>(
            registry,
            CLOSE,
            SessionId {
                session_id: session.started.session_id,
            },
        )
        .await;
    }
}

pub(super) fn connection(
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    mut options: RdpOptions,
    route: Endpoint,
) -> Connection {
    // The core owns the already-authorized gateway transport and credentials.
    options.gateway = None;
    Connection {
        host,
        port,
        username,
        password: password.map(Into::into),
        options,
        route,
    }
}

async fn invoke<T: DeserializeOwned>(
    registry: &PluginRegistry,
    command: &'static str,
    request: impl Serialize,
) -> Result<T, String> {
    let registry = registry.clone();
    let payload = serde_json::to_value(request).map_err(|error| error.to_string())?;
    let result =
        tauri::async_runtime::spawn_blocking(move || registry.invoke(SLUG, command, payload))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
    serde_json::from_value(result).map_err(|error| error.to_string())
}
