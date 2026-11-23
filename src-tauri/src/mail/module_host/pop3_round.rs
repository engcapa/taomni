//! Broker the account's ledger while the signed host runs the POP3 session.

use std::sync::Arc;

use taomni_mail_api::{
    SYNC_POP3_ROUND,
    imap_exchange::read_body_frame,
    pop3_exchange::{
        Pop3LedgerRequest, Pop3Round, Pop3SyncOutcome, read_ledger_message, write_ledger_message,
    },
};
use taomni_mail_engine::pop3::Pop3Ledger;
use taomni_plugin_stream::routed_tcp::Route;
use tokio::runtime::Handle;

use super::{
    PluginRegistry, ResolvedMailAccount, bind_incoming, invoke, pop3::with_deadline, supports,
};

pub(in crate::mail) fn runs_pop3_rounds(registry: &PluginRegistry) -> bool {
    supports(registry, SYNC_POP3_ROUND)
}

pub(in crate::mail) fn run_pop3_round(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    runtime: Handle,
    ledger: &dyn Pop3Ledger,
) -> Result<Pop3SyncOutcome, String> {
    let (_incoming, _ledger_route, mut peer) = runtime.block_on(with_deadline(async {
        let (incoming, connection) = bind_incoming(account).await?;
        let (route, endpoint, peer) = Route::pair().await.map_err(|error| error.to_string())?;
        invoke::<(), _>(
            registry,
            SYNC_POP3_ROUND,
            Pop3Round {
                connection,
                ledger: endpoint,
                leave_days: account.config.pop3_leave_days,
            },
        )
        .await?;
        Ok((incoming, route, peer))
    }))?;
    // Work with SQLite on the calling blocking thread. The two route guards
    // close the database exchange and server connection if the round aborts.
    loop {
        let request = runtime.block_on(with_deadline(async {
            read_ledger_message::<Pop3LedgerRequest>(&mut peer)
                .await
                .map_err(|error| error.to_string())
        }))?;
        let reply = match request {
            Pop3LedgerRequest::Known => serde_json::to_value(ledger.known_messages()),
            Pop3LedgerRequest::Save { uidl, fetched_at } => {
                let original = runtime.block_on(with_deadline(async {
                    read_body_frame(&mut peer)
                        .await
                        .map_err(|error| error.to_string())
                }))?;
                serde_json::to_value(ledger.save_message(&uidl, fetched_at, &original))
            }
            Pop3LedgerRequest::RefreshCounts => serde_json::to_value(ledger.refresh_counts()),
            Pop3LedgerRequest::ConfirmDeletions { uidls } => {
                let uidls: Vec<_> = uidls.iter().map(String::as_str).collect();
                serde_json::to_value(ledger.confirm_deletions(&uidls))
            }
            Pop3LedgerRequest::Complete(result) => return result,
        }
        .map_err(|error| error.to_string())?;
        runtime.block_on(with_deadline(async {
            write_ledger_message(&mut peer, &reply)
                .await
                .map_err(|error| error.to_string())
        }))?;
    }
}
