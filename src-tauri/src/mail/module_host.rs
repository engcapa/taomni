//! Bind the session's resolved mail route and grant it only to the verified host.

use std::{net::SocketAddr, sync::Arc};

use taomni_mail_api::{CHECK_INCOMING, IncomingTest, SLUG};
use taomni_plugin_stream::routed_tcp::Route;

use crate::{
    plugin::{LifecycleState, PluginRegistry},
    terminal::ssh::{SshTransport, build_ssh_transport},
};

use super::ResolvedMailAccount;

pub(super) fn checks_incoming(registry: &PluginRegistry) -> bool {
    registry.get(SLUG).is_some_and(|record| {
        record.state == LifecycleState::Enabled && record.manifest.commands.contains(CHECK_INCOMING)
    })
}

pub(super) async fn check_incoming(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
) -> Result<usize, String> {
    let server = &account.config.imap;
    let server_name = server.host.trim().to_owned();
    let port = server.port;
    let network = account.network_settings.clone();
    let dial_name = server_name.clone();
    let (_route, endpoint) = Route::bind(move || {
        let host = dial_name.clone();
        let network = network.clone();
        async move {
            let stream = build_ssh_transport(&host, port, network.as_ref()).await?;
            let address = match &stream {
                SshTransport::Tcp(socket) => {
                    socket.local_addr().map_err(|error| error.to_string())?
                }
                SshTransport::Jump { .. } => SocketAddr::from(([0, 0, 0, 0], 0)),
            };
            Ok((stream, address))
        }
    })
    .await
    .map_err(|error| format!("Mail module route: {error}"))?;
    let request = IncomingTest {
        route: endpoint,
        server_name,
        security: server.security,
        trusted_certificate: server.trusted_cert.clone(),
        protocol: account.config.incoming,
        provider: account.config.provider,
        authentication: account.auth_mode,
        username: account.imap_username.clone(),
        secret: account.imap_password.clone().into(),
    };
    let result = tokio::task::spawn_blocking(move || {
        let payload = serde_json::to_value(request).map_err(|error| error.to_string())?;
        registry
            .invoke(SLUG, CHECK_INCOMING, payload)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Mail module connection test task: {error}"))??;
    serde_json::from_value::<Result<usize, String>>(result)
        .map_err(|_| "Invalid Mail module connection test response".to_owned())?
}
