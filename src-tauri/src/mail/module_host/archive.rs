//! Client for a dedicated IMAP connection in the signed Mail host.

use std::sync::Arc;

use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    OPEN_IMAP_ARCHIVE, OPEN_IMAP_IMPORT,
    imap_exchange::{ImapExchange, read_frame, write_body_frame, write_frame},
};
use taomni_mail_engine::archive::{ArchiveChunk, ArchiveQuery, CHUNK};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::DuplexStream;

use super::{
    PluginRegistry, ResolvedMailAccount, bind_incoming, decode_imap_reply, invoke, supports,
};

pub(in crate::mail) fn archives_imap(registry: &PluginRegistry) -> bool {
    supports(registry, OPEN_IMAP_ARCHIVE)
}

pub(in crate::mail) fn imports_imap(registry: &PluginRegistry) -> bool {
    supports(registry, OPEN_IMAP_IMPORT)
}

pub(in crate::mail) struct HostedImap {
    _incoming: Route,
    _exchange: Route,
    peer: DuplexStream,
}

impl HostedImap {
    pub(in crate::mail) async fn open(
        registry: Arc<PluginRegistry>,
        account: &ResolvedMailAccount,
        method: &'static str,
    ) -> Result<Self, String> {
        let (_incoming, connection) = bind_incoming(account).await?;
        let (_exchange, exchange, mut peer) =
            Route::pair().await.map_err(|error| error.to_string())?;
        invoke::<(), _>(
            registry,
            method,
            ImapExchange {
                connection,
                exchange,
            },
        )
        .await?;
        let frame = read_frame(&mut peer)
            .await
            .map_err(|error| error.to_string())?;
        decode_imap_reply::<()>(frame).await?;
        Ok(Self {
            _incoming,
            _exchange,
            peer,
        })
    }

    pub(in crate::mail) async fn query<T: DeserializeOwned + Send + 'static>(
        &mut self,
        query: impl Serialize,
    ) -> Result<T, String> {
        self.exchange(query, None).await
    }

    pub(in crate::mail) async fn exchange<T: DeserializeOwned + Send + 'static>(
        &mut self,
        query: impl Serialize,
        body: Option<Vec<u8>>,
    ) -> Result<T, String> {
        let bytes = serde_json::to_vec(&query).map_err(|error| error.to_string())?;
        write_frame(&mut self.peer, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        if let Some(body) = body {
            write_body_frame(&mut self.peer, &body)
                .await
                .map_err(|error| error.to_string())?;
        }
        let frame = read_frame(&mut self.peer)
            .await
            .map_err(|error| error.to_string())?;
        decode_imap_reply(frame).await
    }

    pub(in crate::mail) async fn chunk(
        &mut self,
        query: ArchiveQuery,
    ) -> Result<(u32, u64, Vec<u8>), String> {
        let receipt: ArchiveChunk = self.query(query).await?;
        if receipt.length > CHUNK {
            return Err("Mail module returned an oversized archive chunk".into());
        }
        let bytes = read_frame(&mut self.peer)
            .await
            .map_err(|error| error.to_string())?;
        if receipt.length != bytes.len() {
            return Err("Mail module returned an incomplete archive chunk".into());
        }
        Ok((receipt.uid_validity, receipt.reported_size, bytes))
    }
}
