//! Run the server transaction in the host with the current mailbox ledger.

use std::{cell::RefCell, collections::HashMap};

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, MailIncomingProtocol,
    imap_exchange::write_body_frame,
    message::MailMessageHeader,
    pop3_exchange::{
        Pop3LedgerRequest, Pop3Round, Pop3SyncOutcome, read_ledger_message, write_ledger_message,
    },
};
use taomni_mail_engine::pop3::{Pop3Ledger, sync_inbox};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{
    net::TcpStream,
    runtime::{Handle, Runtime},
    time::timeout,
};

use super::incoming::{configure, open_pop3, while_current};

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: Pop3Round,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Pop3
        || request.connection.server_name.trim().is_empty()
        || request.connection.username.trim().is_empty()
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let (peer, _) = match runtime.block_on(while_current(operation, request.ledger.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    operation.check_current()?;
    let handle = runtime.handle().clone();
    runtime.spawn_blocking(move || {
        let ledger = RoutedLedger {
            peer: RefCell::new(peer),
            runtime: handle,
        };
        let outcome = run(&ledger, request);
        let _ = ledger.runtime.block_on(async {
            timeout(
                HOST_REQUEST_TIMEOUT,
                write_ledger_message(
                    &mut *ledger.peer.borrow_mut(),
                    &Pop3LedgerRequest::Complete(outcome),
                ),
            )
            .await
        });
    });
    Ok(Ok(()))
}

fn run(ledger: &RoutedLedger, request: Pop3Round) -> Result<Pop3SyncOutcome, String> {
    let (network, _) = ledger
        .runtime
        .block_on(request.connection.route.connect())?;
    let stream = network.into_std().map_err(|error| error.to_string())?;
    configure(&stream, MailIncomingProtocol::Pop3).map_err(|error| error.message)?;
    let mut client = open_pop3(stream, &request.connection)?;
    sync_inbox(&mut client, ledger, request.leave_days)
}

struct RoutedLedger {
    peer: RefCell<TcpStream>,
    runtime: Handle,
}

impl RoutedLedger {
    fn exchange<T: DeserializeOwned>(
        &self,
        request: Pop3LedgerRequest,
        original: Option<&[u8]>,
    ) -> Result<T, String> {
        let mut peer = self.peer.borrow_mut();
        self.runtime
            .block_on(async {
                timeout(HOST_REQUEST_TIMEOUT, async {
                    write_ledger_message(&mut *peer, &request).await?;
                    if let Some(original) = original {
                        write_body_frame(&mut *peer, original).await?;
                    }
                    read_ledger_message::<Result<T, String>>(&mut *peer).await
                })
                .await
            })
            .map_err(|_| "POP3 ledger request timed out".to_owned())?
            .map_err(|error| error.to_string())?
    }
}

impl Pop3Ledger for RoutedLedger {
    fn known_messages(&self) -> Result<HashMap<String, i64>, String> {
        self.exchange(Pop3LedgerRequest::Known, None)
    }

    fn save_message(
        &self,
        uidl: &str,
        fetched_at: i64,
        original: &[u8],
    ) -> Result<Option<MailMessageHeader>, String> {
        self.exchange(
            Pop3LedgerRequest::Save {
                uidl: uidl.to_owned(),
                fetched_at,
            },
            Some(original),
        )
    }

    fn refresh_counts(&self) -> Result<(), String> {
        self.exchange(Pop3LedgerRequest::RefreshCounts, None)
    }

    fn confirm_deletions(&self, uidls: &[&str]) -> Result<(), String> {
        self.exchange(
            Pop3LedgerRequest::ConfirmDeletions {
                uidls: uidls.iter().map(|uidl| uidl.to_string()).collect(),
            },
            None,
        )
    }
}
