//! Open one-use transports to a signed POP3 mailbox owner.

use std::{path::Path, sync::Arc};

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, MailboxRequest,
    archive_index::ArchiveEntry,
    imap_exchange::{read_body_frame, write_body_frame},
    pop3_exchange::{Pop3SyncOutcome, read_ledger_message},
    pop3_store::{
        LOCAL_MAILBOX, LocalArchiveAction, LocalMailboxAction, OwnedPop3Round, SYNC_OWNED_MAILBOX,
    },
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::time::timeout;

use super::{
    PluginRegistry, ResolvedMailAccount, archive_original::save_export, bind_incoming, invoke,
};

pub(in crate::mail) async fn run<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account: &str,
    action: LocalMailboxAction,
) -> Result<T, String> {
    let request = MailboxRequest {
        account_id: account.to_owned(),
        action,
    };
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
        tokio::try_join!(invoke::<(), _>(registry, LOCAL_MAILBOX, endpoint), exchange)
    })
    .await
    .map_err(|_| "Mail POP3 mailbox request timed out".to_string())??;
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
    let (_reply, reply, mut peer) = Route::pair().await.map_err(|e| e.to_string())?;
    let request = OwnedPop3Round {
        account_id: account.config.session_id.clone(),
        connection,
        reply,
        leave_days: account.config.pop3_leave_days,
    };
    let exchange = async {
        read_ledger_message::<Result<Pop3SyncOutcome, String>>(&mut peer)
            .await
            .map_err(|e| e.to_string())?
    };
    let ((), outcome) = timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, SYNC_OWNED_MAILBOX, request),
            exchange
        )
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
