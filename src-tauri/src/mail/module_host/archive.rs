//! Client for a dedicated IMAP connection in the signed Mail host.

use std::{path::PathBuf, sync::Arc};

use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, OPEN_IMAP_ARCHIVE, OPEN_IMAP_IMPORT,
    archive::{ArchiveChunk, ArchiveQuery, IMAP_ARCHIVE_CHUNK_BYTES},
    archive_index::{
        ArchiveIndexAction, ArchiveIndexRequest, ArchiveIndexSource, QUERY_ARCHIVE_INDEX,
    },
    imap_exchange::{ImapExchange, read_body_frame, read_frame, write_body_frame, write_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::{AsyncReadExt, DuplexStream};

use super::{
    PluginRegistry, ResolvedMailAccount, bind_incoming, decode_imap_reply, invoke, supports,
};
use crate::state::MailDbHandle;

pub(in crate::mail) fn queries_archive_index(registry: &PluginRegistry) -> bool {
    supports(registry, QUERY_ARCHIVE_INDEX)
}

pub(in crate::mail) async fn query_archive_index<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    account_id: String,
    account_cache: Option<MailDbHandle>,
    action: ArchiveIndexAction,
) -> Result<T, String> {
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let runtime = tokio::runtime::Handle::current();
    let transfer = async move {
        if peer.read_u8().await.map_err(|error| error.to_string())? != 1 {
            return Err("Invalid Mail archive index request".into());
        }
        tokio::task::spawn_blocking(move || {
            // The host already accepted the route. Hold the cache lease while
            // the host reads so relocation cannot replace the selected index.
            let connection = account_cache
                .as_ref()
                .map(|cache| cache.lock())
                .transpose()?;
            let source = match &connection {
                Some(db) => {
                    let path = db.path().ok_or("Mail storage has no disk path")?;
                    let database = PathBuf::from(path)
                        .canonicalize()
                        .map_err(|error| format!("Resolve Mail archive index: {error}"))?;
                    ArchiveIndexSource::AccountCache { database }
                }
                None => ArchiveIndexSource::ModuleData,
            };
            let request = ArchiveIndexRequest {
                account_id,
                source,
                action,
            };
            let request = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
            let reply = runtime
                .block_on(async {
                    write_frame(&mut peer, &request).await?;
                    read_body_frame(&mut peer).await
                })
                .map_err(|error| error.to_string())?;
            drop(connection);
            serde_json::from_slice::<Result<T, String>>(&reply)
                .map_err(|_| "Invalid Mail archive index reply".to_owned())?
        })
        .await
        .map_err(|error| error.to_string())?
    };
    let ((), result) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, QUERY_ARCHIVE_INDEX, endpoint),
            transfer
        )
    })
    .await
    .map_err(|_| "Mail archive index request timed out".to_owned())??;
    Ok(result)
}

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
        if receipt.length > IMAP_ARCHIVE_CHUNK_BYTES {
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
