//! Open one-use transports to a signed POP3 mailbox host.

use std::{path::Path, sync::Arc};

use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, MailboxRequest,
    archive_index::ArchiveEntry,
    imap_exchange::{read_body_frame, write_body_frame},
    pop3_exchange::{Pop3SyncOutcome, read_ledger_message},
    pop3_store::{
        LEGACY_LOCAL_MAILBOX, LOCAL_MAILBOX, LegacyMailboxRequest, LegacyPop3Round,
        LocalArchiveAction, LocalMailboxAction, OwnedPop3Round, SYNC_LEGACY_MAILBOX,
        SYNC_OWNED_MAILBOX,
    },
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::time::timeout;

use super::{
    PluginRegistry, ResolvedMailAccount, archive_original::save_export, bind_incoming, invoke,
    supports,
};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn supports_legacy(registry: &PluginRegistry) -> bool {
    supports(registry, LEGACY_LOCAL_MAILBOX) && supports(registry, SYNC_LEGACY_MAILBOX)
}

pub(in crate::mail) async fn run<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account: &str,
    action: LocalMailboxAction,
) -> Result<T, String> {
    let request = MailboxRequest {
        account_id: account.to_owned(),
        action,
    };
    exchange_mailbox(
        registry,
        LOCAL_MAILBOX,
        request,
        "Mail POP3 mailbox request timed out",
    )
    .await
}

pub(in crate::mail) async fn run_legacy<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account: &str,
    action: LocalMailboxAction,
) -> Result<T, String> {
    let database = tokio::task::spawn_blocking(move || canonical_cache_database(&cache))
        .await
        .map_err(|e| e.to_string())??;
    let request = LegacyMailboxRequest {
        account_id: account.to_owned(),
        database,
        action,
    };
    exchange_mailbox(
        registry,
        LEGACY_LOCAL_MAILBOX,
        request,
        "Mail legacy POP3 mailbox request timed out",
    )
    .await
}

async fn exchange_mailbox<T: DeserializeOwned + Send + 'static, P: Serialize + Send + 'static>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    request: P,
    timeout_message: &'static str,
) -> Result<T, String> {
    let encoded = tokio::task::spawn_blocking(move || serde_json::to_vec(&request))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|e| e.to_string())?;
    let exchange = async {
        write_body_frame(&mut peer, &encoded)
            .await
            .map_err(|e| e.to_string())?;
        read_body_frame(&mut peer).await.map_err(|e| e.to_string())
    };
    let ((), reply) = timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(invoke::<(), _>(registry, method, endpoint), exchange)
    })
    .await
    .map_err(|_| timeout_message.to_string())??;
    tokio::task::spawn_blocking(move || serde_json::from_slice(&reply))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

pub(in crate::mail) async fn sync(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
) -> Result<Pop3SyncOutcome, String> {
    let (_incoming, connection) = bind_incoming(account).await?;
    let (_reply, reply, peer) = Route::pair().await.map_err(|e| e.to_string())?;
    let request = OwnedPop3Round {
        account_id: account.config.session_id.clone(),
        connection,
        reply,
        leave_days: account.config.pop3_leave_days,
    };
    exchange_round(registry, SYNC_OWNED_MAILBOX, request, peer).await
}

pub(in crate::mail) async fn sync_legacy(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account: &ResolvedMailAccount,
) -> Result<Pop3SyncOutcome, String> {
    let database = tokio::task::spawn_blocking(move || canonical_cache_database(&cache))
        .await
        .map_err(|e| e.to_string())??;
    let (_incoming, connection) = bind_incoming(account).await?;
    let (_reply, reply, peer) = Route::pair().await.map_err(|e| e.to_string())?;
    let request = LegacyPop3Round {
        account_id: account.config.session_id.clone(),
        database,
        connection,
        reply,
        leave_days: account.config.pop3_leave_days,
    };
    exchange_round(registry, SYNC_LEGACY_MAILBOX, request, peer).await
}

async fn exchange_round<P: Serialize + Send + 'static>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    request: P,
    mut peer: tokio::io::DuplexStream,
) -> Result<Pop3SyncOutcome, String> {
    let exchange = async {
        read_ledger_message::<Result<Pop3SyncOutcome, String>>(&mut peer)
            .await
            .map_err(|e| e.to_string())?
    };
    let ((), outcome) = timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(invoke::<(), _>(registry, method, request), exchange)
    })
    .await
    .map_err(|_| "Mail POP3 synchronization timed out".to_string())??;
    Ok(outcome)
}

pub(in crate::mail) async fn export(
    registry: Arc<PluginRegistry>,
    account: String,
    entry: ArchiveEntry,
    attachment_index: Option<usize>,
    target: &Path,
) -> Result<(), String> {
    let request = MailboxRequest {
        account_id: account,
        action: LocalMailboxAction::Archive(LocalArchiveAction::Export {
            entry,
            attachment_index,
        }),
    };
    let encoded = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    save_export(registry, LOCAL_MAILBOX, encoded, target).await
}
