//! Compatibility relay for isolated QA of legacy and signed RDP clients.

use std::time::Duration;

use taomni_rdp_client_api::{ConnectionTestResult, transport::gateway_socket};
use taomni_rdp_client_engine::{
    gateway,
    session::{RdpSessionConfig, test_ironrdp_connection},
    ws::{RdpSpawnConfig, spawn_rdp_relay},
};
use uuid::Uuid;

use super::{ConnectionSettings, DesktopRdpSession, RdpConnectResult, transport};

fn config(settings: ConnectionSettings) -> RdpSpawnConfig {
    let ConnectionSettings {
        host,
        port,
        username,
        password,
        options,
        network,
    } = settings;
    let connect = if let Some(gateway) = &options.gateway {
        let channel = gateway_socket(&gateway.host, gateway.port);
        gateway::connector(
            gateway.clone(),
            host.clone(),
            port,
            channel.clone(),
            channel,
        )
    } else {
        transport::connector(host.clone(), port, network)
    };
    RdpSpawnConfig {
        host,
        port,
        username,
        password,
        options,
        connect,
    }
}

pub(super) async fn start(
    settings: ConnectionSettings,
) -> Result<(RdpConnectResult, DesktopRdpSession), String> {
    let session = spawn_rdp_relay(config(settings)).await?;
    let result = RdpConnectResult {
        session_id: Uuid::new_v4().to_string(),
        ws_port: session.ws_port,
        ws_token: session.ws_token.clone(),
    };
    Ok((result, DesktopRdpSession::Local(session)))
}

pub(super) async fn test(settings: ConnectionSettings) -> Result<ConnectionTestResult, String> {
    let RdpSpawnConfig {
        host,
        port,
        username,
        password,
        options,
        connect,
    } = config(settings);
    let transport = connect().await?;
    test_ironrdp_connection(
        RdpSessionConfig {
            transport,
            host,
            port,
            username,
            password,
            options,
            reconnect: connect,
        },
        Duration::from_secs(45),
    )
    .await
}
