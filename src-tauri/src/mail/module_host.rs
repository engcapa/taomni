//! Bind the session's resolved mail route and grant it only to the verified host.

use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use lettre::address::Envelope;
use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    CHECK_INCOMING, CHECK_OUTGOING, FETCH_IMAP_RAW, FolderSubscription, HOST_REQUEST_TIMEOUT,
    IMAP_FOLDER_TREE, ImapFlagUpdate, ImapFolderTree, IncomingTest, LIST_IMAP_UNREAD, SEARCH_IMAP,
    SEND_SMTP, SET_IMAP_FLAGS, SLUG, SMTP_DELIVERY_UNKNOWN, SYNC_IMAP_HEADERS, SYNC_IMAP_ROUND,
    SmtpConnection, SmtpDelivery,
    imap_exchange::{ImapExchange, RawMessageRequest, read_frame, write_frame},
};
use taomni_mail_engine::imap_sync::{
    FolderRoundOutcome, FolderRoundRequest, FolderStepOutcome, HeaderStepRequest,
};
use taomni_mail_engine::search::ImapSearchRequest;
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};
use tokio::io::AsyncReadExt;

use crate::{
    plugin::{LifecycleState, PluginRegistry},
    terminal::{
        network::NetworkSettings,
        ssh::{SshTransport, build_ssh_transport},
    },
};

use super::{MailFolder, MailMessageHeader, ResolvedMailAccount};

pub(super) fn checks_incoming(registry: &PluginRegistry) -> bool {
    supports(registry, CHECK_INCOMING)
}

pub(super) fn manages_imap_folders(registry: &PluginRegistry) -> bool {
    supports(registry, IMAP_FOLDER_TREE)
}

pub(super) fn syncs_imap_headers(registry: &PluginRegistry) -> bool {
    supports(registry, SYNC_IMAP_HEADERS)
}

pub(super) fn syncs_imap_round(registry: &PluginRegistry) -> bool {
    supports(registry, SYNC_IMAP_ROUND)
}

pub(super) fn searches_imap(registry: &PluginRegistry) -> bool {
    supports(registry, SEARCH_IMAP)
}

pub(super) fn sets_imap_flags(registry: &PluginRegistry) -> bool {
    supports(registry, SET_IMAP_FLAGS)
}

pub(super) fn lists_imap_unread(registry: &PluginRegistry) -> bool {
    supports(registry, LIST_IMAP_UNREAD)
}

pub(super) fn fetches_imap_raw(registry: &PluginRegistry) -> bool {
    supports(registry, FETCH_IMAP_RAW)
}

pub(super) async fn sync_imap_headers(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    step: &HeaderStepRequest,
) -> Result<FolderStepOutcome, String> {
    let outcome: FolderStepOutcome =
        exchange_imap(registry, account, SYNC_IMAP_HEADERS, step).await?;
    if outcome.folder.account_id != step.account_id || outcome.folder.name != step.folder {
        return Err("Mail module returned another folder's result".into());
    }
    Ok(outcome)
}

pub(super) async fn sync_imap_round(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    request: &FolderRoundRequest,
) -> Result<FolderRoundOutcome, String> {
    let outcome: FolderRoundOutcome =
        exchange_imap(registry, account, SYNC_IMAP_ROUND, request).await?;
    if outcome
        .steps
        .iter()
        .map(|step| &step.folder)
        .chain(outcome.unchanged.as_ref())
        .any(|folder| {
            folder.account_id != request.folder.account_id || folder.name != request.folder.name
        })
    {
        return Err("Mail module returned another folder's result".into());
    }
    if let Some(error) = &outcome.error
        && super::is_imap_transport_error(error)
    {
        return Err(error.clone());
    }
    Ok(outcome)
}

pub(super) async fn search_imap(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    request: &ImapSearchRequest,
) -> Result<Vec<MailMessageHeader>, String> {
    let results: Vec<MailMessageHeader> =
        exchange_imap(registry, account, SEARCH_IMAP, request).await?;
    if results
        .iter()
        .any(|message| message.account_id != request.account_id || message.folder != request.folder)
    {
        return Err("Mail module returned another folder's search results".into());
    }
    Ok(results)
}

pub(super) async fn set_imap_flags(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    update: &ImapFlagUpdate,
) -> Result<(), String> {
    let updated: usize = exchange_imap(registry, account, SET_IMAP_FLAGS, update).await?;
    if updated != update.uids.len() {
        return Err("Mail module returned an incomplete flag update".into());
    }
    Ok(())
}

pub(super) async fn list_imap_unread(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    folder: &str,
) -> Result<Vec<u32>, String> {
    exchange_imap(registry, account, LIST_IMAP_UNREAD, &folder).await
}

pub(super) async fn fetch_imap_raw(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    let (_route, exchange, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let receive = async {
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes)
            .await
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(bytes)
    };
    let invoke =
        invoke_with_incoming::<usize, _>(registry, account, FETCH_IMAP_RAW, |connection| {
            RawMessageRequest {
                connection,
                exchange,
                folder: folder.to_owned(),
                uid,
            }
        });
    let (expected, bytes) =
        tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), async {
            tokio::try_join!(invoke, receive)
        })
        .await
        .map_err(|_| "Mail original fetch timed out".to_owned())??;
    if bytes.len() != expected {
        return Err("Mail module returned an incomplete original message".into());
    }
    Ok(bytes)
}

async fn exchange_imap<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    method: &'static str,
    request: &impl Serialize,
) -> Result<T, String> {
    let bytes = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    let (_data_route, endpoint, mut peer) =
        Route::pair().await.map_err(|error| error.to_string())?;
    let exchange = async {
        write_frame(&mut peer, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        read_frame(&mut peer)
            .await
            .map_err(|error| error.to_string())
    };
    let invoke =
        invoke_with_incoming::<(), _>(registry, account, method, |connection| ImapExchange {
            connection,
            exchange: endpoint,
        });
    let (_, frame) = tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), async {
        tokio::try_join!(invoke, exchange)
    })
    .await
    .map_err(|_| "Mail module IMAP request timed out".to_owned())??;
    tokio::task::spawn_blocking(move || {
        serde_json::from_slice::<Result<T, String>>(&frame)
            .map_err(|_| "Invalid Mail IMAP result".to_owned())?
    })
    .await
    .map_err(|error| error.to_string())?
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
    let call = PendingMailCall {
        registry: registry.clone(),
        id: uuid::Uuid::new_v4().to_string(),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    let id = call.id.clone();
    let cancelled = call.cancelled.clone();
    let result = tokio::task::spawn_blocking(move || {
        let payload = serde_json::to_value(request).map_err(|error| error.to_string())?;
        registry
            .invoke_cancellable(SLUG, method, payload, &id, || {
                cancelled.load(Ordering::Acquire)
            })
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Mail module request failed: {error}"))??;
    serde_json::from_value::<Result<T, String>>(result)
        .map_err(|_| "Invalid Mail module response".to_owned())
}

struct PendingMailCall {
    registry: Arc<PluginRegistry>,
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl Drop for PendingMailCall {
    fn drop(&mut self) {
        // The blocking worker can still be queued when an IMAP transfer times out.
        self.cancelled.store(true, Ordering::Release);
        self.registry.cancel_request(SLUG, &self.id);
    }
}
