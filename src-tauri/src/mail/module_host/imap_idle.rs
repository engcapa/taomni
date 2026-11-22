//! Keep the route alive only for the owning Mail watcher.

use std::sync::Arc;

use taomni_mail_api::{
    OPEN_IMAP_IDLE,
    imap_exchange::{ImapIdleNotice, OpenImapIdle, read_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::DuplexStream;

use super::{PluginRegistry, ResolvedMailAccount, bind_incoming, invoke, supports};

pub(in crate::mail) fn available(registry: &PluginRegistry) -> bool {
    supports(registry, OPEN_IMAP_IDLE)
}

pub(in crate::mail) struct HostedIdle {
    _network_route: Route,
    _exchange: Route,
    peer: DuplexStream,
}

impl HostedIdle {
    pub(in crate::mail) async fn open(
        registry: Arc<PluginRegistry>,
        account: &ResolvedMailAccount,
        folder: &str,
    ) -> Result<Self, String> {
        let (network_route, connection) = bind_incoming(account).await?;
        let (exchange, endpoint, peer) = Route::pair().await.map_err(|error| error.to_string())?;
        invoke::<(), _>(
            registry,
            OPEN_IMAP_IDLE,
            OpenImapIdle {
                connection,
                exchange: endpoint,
                folder: folder.to_owned(),
            },
        )
        .await?;
        Ok(Self {
            _network_route: network_route,
            _exchange: exchange,
            peer,
        })
    }

    pub(in crate::mail) async fn next(&mut self) -> Result<ImapIdleNotice, String> {
        let frame = read_frame(&mut self.peer)
            .await
            .map_err(|error| format!("Mail IDLE host: {error}"))?;
        serde_json::from_slice(&frame).map_err(|_| "Invalid Mail IDLE notification".into())
    }
}
