//! Bind the session's resolved mail route and grant it only to the verified host.

use std::{net::SocketAddr, sync::Arc};

use lettre::address::Envelope;
use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    CHECK_INCOMING, CHECK_OUTGOING, FolderSubscription, IMAP_FOLDER_TREE, ImapFolderTree,
    IncomingTest, SEND_SMTP, SLUG, SMTP_DELIVERY_UNKNOWN, SmtpConnection, SmtpDelivery,
};
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};

use crate::{
    plugin::{LifecycleState, PluginRegistry},
    terminal::{
        network::NetworkSettings,
        ssh::{SshTransport, build_ssh_transport},
    },
};

use super::{MailFolder, ResolvedMailAccount};

pub(super) fn checks_incoming(registry: &PluginRegistry) -> bool {
    supports(registry, CHECK_INCOMING)
}

pub(super) fn manages_imap_folders(registry: &PluginRegistry) -> bool {
    supports(registry, IMAP_FOLDER_TREE)
}

pub(super) async fn test_smtp(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
) -> Result<(), String> {
    if !supports(&registry, CHECK_OUTGOING) {
        let account = account.clone();
        let runtime = tokio::runtime::Handle::current();
        return tokio::task::spawn_blocking(move || super::smtp::test_smtp(&account, &runtime))
            .await
            .map_err(|error| format!("SMTP test task failed: {error}"))?;
    }
    let (_route, request) = bind_smtp(account).await?;
    invoke(registry, CHECK_OUTGOING, request).await
}

pub(super) async fn send_smtp(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    envelope: Envelope,
    mime: Vec<u8>,
) -> Result<String, String> {
    if !supports(&registry, SEND_SMTP) {
        let account = account.clone();
        let runtime = tokio::runtime::Handle::current();
        return tokio::task::spawn_blocking(move || {
            let transport = super::smtp::build_smtp_transport(&account, &runtime)?;
            let response = transport.mailer.send_raw(&envelope, &mime)?;
            Ok(format!("{response:?}"))
        })
        .await
        .map_err(|error| format!("SMTP send task failed: {error}"))?;
    }
    let (_route, connection) = bind_smtp(account).await?;
    let mime_length = mime.len() as u64;
    let (_offer, mime_source) = Route::offer_bytes(mime)
        .await
        .map_err(|error| format!("Prepare outgoing message: {error}"))?;
    let request = SmtpDelivery {
        connection,
        sender: envelope.from().map(ToString::to_string),
        recipients: envelope.to().iter().map(ToString::to_string).collect(),
        mime_source,
        mime_length,
    };
    // The host may have received SMTP acceptance before losing the response.
    invoke_result(registry, SEND_SMTP, request)
        .await
        .map_err(|error| {
            format!("{SMTP_DELIVERY_UNKNOWN}: {error}. Verify delivery before resending.")
        })?
}

async fn bind_smtp(account: &ResolvedMailAccount) -> Result<(Route, SmtpConnection), String> {
    let server = &account.config.smtp;
    let server_name = server.host.trim().to_owned();
    let (route, endpoint) = bind_route(
        server_name.clone(),
        server.port,
        account.network_settings.clone(),
    )
    .await?;
    Ok((
        route,
        SmtpConnection {
            route: endpoint,
            server_name,
            security: server.security,
            trusted_certificate: server.trusted_cert.clone(),
            authentication: account.auth_mode,
            username: account.smtp_username.clone(),
            secret: account.smtp_password.clone().into(),
        },
    ))
}

fn supports(registry: &PluginRegistry, method: &str) -> bool {
    registry.get(SLUG).is_some_and(|record| {
        record.state == LifecycleState::Enabled && record.manifest.commands.contains(method)
    })
}

pub(super) async fn check_incoming(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
) -> Result<usize, String> {
    invoke_with_incoming(registry, account, CHECK_INCOMING, |connection| connection).await
}

pub(super) async fn imap_folder_tree(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    subscription: Option<FolderSubscription>,
) -> Result<Vec<MailFolder>, String> {
    invoke_with_incoming(registry, account, IMAP_FOLDER_TREE, |connection| {
        ImapFolderTree {
            connection,
            account_id: account.config.session_id.clone(),
            subscription,
        }
    })
    .await
}

async fn invoke_with_incoming<T: DeserializeOwned, P: Serialize + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    method: &'static str,
    build_request: impl FnOnce(IncomingTest) -> P,
) -> Result<T, String> {
    let server = &account.config.imap;
    let server_name = server.host.trim().to_owned();
    let (_route, endpoint) = bind_route(
        server_name.clone(),
        server.port,
        account.network_settings.clone(),
    )
    .await?;
    let connection = IncomingTest {
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
    invoke(registry, method, build_request(connection)).await
}

async fn bind_route(
    host: String,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<(Route, Endpoint), String> {
    Route::bind(move || {
        let host = host.clone();
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
    .map_err(|error| format!("Mail module route: {error}"))
}

async fn invoke<T: DeserializeOwned, P: Serialize + Send + 'static>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    request: P,
) -> Result<T, String> {
    invoke_result(registry, method, request).await?
}

async fn invoke_result<T: DeserializeOwned, P: Serialize + Send + 'static>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    request: P,
) -> Result<Result<T, String>, String> {
    let result = tokio::task::spawn_blocking(move || {
        let payload = serde_json::to_value(request).map_err(|error| error.to_string())?;
        registry
            .invoke(SLUG, method, payload)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Mail module request failed: {error}"))??;
    serde_json::from_value::<Result<T, String>>(result)
        .map_err(|_| "Invalid Mail module response".to_owned())
}
