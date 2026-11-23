//! A single POP3 synchronization session on a core-authorized route.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::{
    IncomingTest,
    imap_exchange::{read_body_frame, write_body_frame},
    message::MailMessageHeader,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pop3Exchange {
    pub connection: IncomingTest,
    pub exchange: Endpoint,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Pop3Command {
    Uidl,
    Retrieve { number: u32 },
    Delete { number: u32 },
    Quit,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pop3Round {
    pub connection: IncomingTest,
    pub ledger: Endpoint,
    pub leave_days: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pop3SyncOutcome {
    pub messages: Vec<MailMessageHeader>,
    pub remaining: usize,
    pub deleted_on_server: usize,
}

/// The host drives the round over an account-scoped one-use ledger. A Save
/// request is followed by the original bytes in a separate frame.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Pop3LedgerRequest {
    Known,
    Save { uidl: String, fetched_at: i64 },
    RefreshCounts,
    ConfirmDeletions { uidls: Vec<String> },
    Complete(Result<Pop3SyncOutcome, String>),
}

pub async fn read_ledger_message<T: DeserializeOwned>(
    stream: &mut (impl AsyncRead + Unpin),
) -> io::Result<T> {
    let bytes = read_body_frame(stream).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

pub async fn write_ledger_message<T: Serialize>(
    stream: &mut (impl AsyncWrite + Unpin),
    message: &T,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(message).map_err(io::Error::other)?;
    write_body_frame(stream, &bytes).await
}
