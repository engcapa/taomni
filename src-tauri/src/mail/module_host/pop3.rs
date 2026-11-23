use std::sync::Arc;

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, OPEN_POP3_SYNC,
    imap_exchange::{read_body_frame, write_frame},
    pop3_exchange::{Pop3Command, Pop3Exchange},
};
use taomni_mail_engine::pop3::Pop3Mailbox;
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{io::DuplexStream, runtime::Handle};

use super::{PluginRegistry, ResolvedMailAccount, bind_incoming, invoke, supports};

pub(in crate::mail) fn syncs_pop3(registry: &PluginRegistry) -> bool {
    supports(registry, OPEN_POP3_SYNC)
}

pub(in crate::mail) struct HostedPop3 {
    runtime: Handle,
    peer: DuplexStream,
    _incoming: Route,
    _exchange: Route,
}

impl HostedPop3 {
    pub(in crate::mail) fn open(
        registry: Arc<PluginRegistry>,
        account: &ResolvedMailAccount,
        runtime: Handle,
    ) -> Result<Self, String> {
        let (peer, _incoming, _exchange) = runtime.block_on(with_deadline(async {
            let (incoming, connection) = bind_incoming(account).await?;
            let (route, exchange, mut peer) = Route::pair().await.map_err(|e| e.to_string())?;
            invoke::<(), _>(
                registry,
                OPEN_POP3_SYNC,
                Pop3Exchange {
                    connection,
                    exchange,
                },
            )
            .await?;
            read_response::<()>(&mut peer).await?;
            Ok((peer, incoming, route))
        }))?;
        Ok(Self {
            runtime,
            peer,
            _incoming,
            _exchange,
        })
    }

    fn request<T: DeserializeOwned>(&mut self, command: Pop3Command) -> Result<T, String> {
        self.runtime
            .block_on(with_deadline(send_request(&mut self.peer, command)))
    }
}

impl Pop3Mailbox for HostedPop3 {
    fn uidl(&mut self) -> Result<Vec<(u32, String)>, String> {
        self.request(Pop3Command::Uidl)
    }

    fn retr(&mut self, number: u32) -> Result<Vec<u8>, String> {
        self.runtime.block_on(with_deadline(async {
            send_request::<()>(&mut self.peer, Pop3Command::Retrieve { number }).await?;
            read_body_frame(&mut self.peer)
                .await
                .map_err(|e| e.to_string())
        }))
    }

    fn dele(&mut self, number: u32) -> Result<(), String> {
        self.request(Pop3Command::Delete { number })
    }

    fn finish(&mut self) -> Result<(), String> {
        self.request(Pop3Command::Quit)
    }
}

pub(super) async fn with_deadline<T>(
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(HOST_REQUEST_TIMEOUT, work)
        .await
        .map_err(|_| "Mail module POP3 request timed out".to_owned())?
}

async fn send_request<T: DeserializeOwned>(
    peer: &mut DuplexStream,
    command: Pop3Command,
) -> Result<T, String> {
    let request = serde_json::to_vec(&command).map_err(|e| e.to_string())?;
    write_frame(peer, &request)
        .await
        .map_err(|e| e.to_string())?;
    read_response(peer).await
}

async fn read_response<T: DeserializeOwned>(peer: &mut DuplexStream) -> Result<T, String> {
    let response = read_body_frame(peer).await.map_err(|e| e.to_string())?;
    serde_json::from_slice::<Result<T, String>>(&response)
        .map_err(|_| "Invalid Mail POP3 result".to_owned())?
}
