use serde::{Serialize, de::DeserializeOwned};
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};
use taomni_rdp_client_api::{
    CLOSE, Connection, ConnectionTestResult, GatewayConnection, SLUG, START, START_GATEWAY,
    SessionId, Started, TEST, TEST_GATEWAY,
    transport::{RdpConnector, gateway_socket},
};
use tokio_util::sync::CancellationToken;

use crate::plugin::{LifecycleState, PluginRegistry};

use super::{ConnectionSettings, transport};

pub(crate) struct ModuleSession {
    pub started: Started,
    routes: Routes,
}

impl ModuleSession {
    pub(super) fn closed(&self) -> CancellationToken {
        self.routes.inbound.closed()
    }
}

struct Routes {
    inbound: Route,
    // Both routes are dropped when the session closes, including either
    // gateway channel still waiting for its upstream connection.
    _outbound: Option<Route>,
}

enum BoundConnection {
    Direct(Connection),
    Gateway(GatewayConnection),
}

async fn bind_route(connector: RdpConnector) -> Result<(Route, Endpoint), String> {
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
    settings: ConnectionSettings,
) -> Result<ModuleSession, String> {
    let (request, routes) = bind_connection(registry, settings, START, START_GATEWAY).await?;
    let started = request.invoke(registry, START, START_GATEWAY).await?;
    Ok(ModuleSession { started, routes })
}

pub(super) async fn test(
    registry: &PluginRegistry,
    settings: ConnectionSettings,
) -> Result<ConnectionTestResult, String> {
    let (request, _routes) = bind_connection(registry, settings, TEST, TEST_GATEWAY).await?;
    request.invoke(registry, TEST, TEST_GATEWAY).await
}

pub(super) async fn close(registry: &PluginRegistry, session: ModuleSession) {
    drop(session.routes);
    if let Some(record) = registry.get(SLUG)
        && record.state == LifecycleState::Enabled
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

async fn bind_connection(
    registry: &PluginRegistry,
    settings: ConnectionSettings,
    direct_method: &'static str,
    gateway_method: &'static str,
) -> Result<(BoundConnection, Routes), String> {
    let ConnectionSettings {
        host,
        port,
        username,
        password,
        options,
        network,
    } = settings;
    let record = registry
        .get(SLUG)
        .filter(|record| record.state == LifecycleState::Enabled)
        .ok_or("RDP Client must be installed and enabled")?;
    let method = if options.gateway.is_some() {
        gateway_method
    } else {
        direct_method
    };
    if !record.manifest.commands.contains(method) {
        return Err("Update the RDP Client module".into());
    }
    let (connector, outbound) = if let Some(gateway) = &options.gateway {
        let connect = gateway_socket(&gateway.host, gateway.port);
        let second = bind_route(connect.clone()).await?;
        (connect, Some(second))
    } else {
        (transport::connector(host.clone(), port, network), None)
    };
    let (inbound, route) = bind_route(connector).await?;
    let connection = Connection {
        host,
        port,
        username,
        password: password.map(Into::into),
        options,
        route,
    };
    if let Some((outbound, endpoint)) = outbound {
        Ok((
            BoundConnection::Gateway(GatewayConnection {
                connection,
                outbound: endpoint,
            }),
            Routes {
                inbound,
                _outbound: Some(outbound),
            },
        ))
    } else {
        Ok((
            BoundConnection::Direct(connection),
            Routes {
                inbound,
                _outbound: None,
            },
        ))
    }
}

impl BoundConnection {
    async fn invoke<T: DeserializeOwned>(
        self,
        registry: &PluginRegistry,
        direct: &'static str,
        gateway: &'static str,
    ) -> Result<T, String> {
        match self {
            Self::Direct(request) => invoke(registry, direct, request).await?,
            Self::Gateway(request) => invoke(registry, gateway, request).await?,
        }
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
