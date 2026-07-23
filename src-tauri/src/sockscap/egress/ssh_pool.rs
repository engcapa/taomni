//! Shared SSH client for SocksCap upstream (one hop, direct-tcpip per flow).

use std::sync::Arc;

use russh::client;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::terminal::ssh::{connect_ssh_authenticated, SshAuth, SshHandler};

/// Long-lived SSH session used as an upstream for many TCP flows.
pub struct SshPool {
    handle: Arc<client::Handle<SshHandler>>,
    pub host: String,
    pub port: u16,
}

impl std::fmt::Debug for SshPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshPool")
            .field("host", &self.host)
            .field("port", &self.port)
            .finish()
    }
}

impl SshPool {
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        auth: SshAuth,
    ) -> Result<Self, String> {
        let handle = connect_ssh_authenticated(host, port, username, auth).await?;
        Ok(Self {
            handle: Arc::new(handle),
            host: host.to_string(),
            port,
        })
    }

    /// Open a `direct-tcpip` channel to `dest_host:dest_port` and return an
    /// async stream suitable for bidirectional bridging.
    pub async fn dial(
        &self,
        dest_host: &str,
        dest_port: u16,
        originator: &str,
        originator_port: u16,
    ) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send, String> {
        let channel = self
            .handle
            .channel_open_direct_tcpip(
                dest_host,
                dest_port as u32,
                originator,
                originator_port as u32,
            )
            .await
            .map_err(|e| format!("ssh direct-tcpip {dest_host}:{dest_port}: {e}"))?;
        Ok(channel.into_stream())
    }
}
