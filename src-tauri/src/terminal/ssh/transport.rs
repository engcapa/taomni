use super::authentication::SshAuth;
use super::connection::SshHandler;
use super::connection::connect_ssh_authenticated_with;
use crate::terminal::network::NetworkSettings;
use crate::terminal::network::establish_transport;
use russh::ChannelStream;
use russh::client;
use russh::client::Msg;
use russh::keys::PrivateKey;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Context;
use std::task::Poll;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadBuf;
use tokio::net::TcpStream;

pub const MISSING_JUMP_PASSWORD_ERROR: &str = "TAOMNI_MISSING_JUMP_PASSWORD";

/// The byte transport an SSH session is layered on top of.
///
/// - `Tcp` — a direct or proxied (HTTP CONNECT / SOCKS5) TCP socket.
/// - `Jump` — a `direct-tcpip` channel opened on an intermediate SSH jump
///   host. The jump host's `Handle` is held alongside the channel stream so
///   the jump connection stays alive exactly as long as the tunnelled stream;
///   dropping the transport tears the jump connection down with it.
pub(crate) enum SshTransport {
    Tcp(TcpStream),
    Jump {
        stream: ChannelStream<Msg>,
        // Kept solely to own the jump connection's lifetime. Dropped together
        // with `stream`.
        #[allow(dead_code)]
        jump: Arc<client::Handle<SshHandler>>,
    },
}

impl AsyncRead for SshTransport {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(s) => Pin::new(s).poll_read(cx, buf),
            Self::Jump { stream, .. } => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for SshTransport {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Self::Tcp(s) => Pin::new(s).poll_write(cx, buf),
            Self::Jump { stream, .. } => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(s) => Pin::new(s).poll_flush(cx),
            Self::Jump { stream, .. } => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(s) => Pin::new(s).poll_shutdown(cx),
            Self::Jump { stream, .. } => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

/// Resolve the byte transport for an SSH connection to `host:port`.
///
/// When `network` selects an SSH jump host (`proxy_kind == "ssh-tunnel"`), we
/// first open an authenticated connection to the jump host (single level — the
/// jump connection itself is always direct, never chained), then open a
/// `direct-tcpip` channel through it to the final target and hand back its
/// stream. Otherwise this is a direct or proxied TCP socket via
/// [`establish_transport`].
///
/// The jump credentials are expected to already be resolved into `network`
/// (host/port/user + plaintext password or key path) by the caller; vault
/// references must be resolved before this point.
///
/// Exposed to the database layer, which bridges this transport to a local
/// loopback listener so non-SSH clients (sqlx / redis-rs / reqwest) can reach
/// a target through the same proxy/jump machinery.
pub(crate) async fn build_ssh_transport(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
) -> Result<SshTransport, String> {
    match network {
        Some(n) if n.uses_jump_host() => {
            if n.jump_host.trim().is_empty() {
                return Err("SSH jump host is empty".into());
            }
            if n.jump_port == 0 {
                return Err("SSH jump port must be greater than 0".into());
            }
            let jump_auth = match n.jump_auth_kind.as_str() {
                "PrivateKey" => {
                    let path = if n.jump_key_path.trim().is_empty() {
                        "~/.ssh/id_ed25519".to_string()
                    } else {
                        n.jump_key_path.clone()
                    };
                    SshAuth::PrivateKey(path)
                }
                _ => SshAuth::Password(n.jump_password.clone()),
            };
            if let SshAuth::Password(password) = &jump_auth {
                if password.is_empty() {
                    return Err(format!(
                        "{MISSING_JUMP_PASSWORD_ERROR}: SSH jump host password is required for {}@{}:{}",
                        n.jump_user, n.jump_host, n.jump_port
                    ));
                }
            }

            // The jump connection is always direct: pass no network settings so
            // it cannot itself recurse into another jump/proxy hop. Boxed to
            // break the async-recursion cycle the compiler sees (this fn ->
            // connect_ssh_authenticated_with -> ... -> this fn); the runtime
            // path never actually recurses because `network` is `None` here.
            let jump = Box::pin(connect_ssh_authenticated_with(
                &n.jump_host,
                n.jump_port,
                &n.jump_user,
                jump_auth,
                None,
            ))
            .await
            .map_err(|e| format!("jump host {}:{}: {}", n.jump_host, n.jump_port, e))?;
            let jump = Arc::new(jump);

            let channel = jump
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    format!(
                        "jump host could not open channel to {}:{}: {}",
                        host, port, e
                    )
                })?;
            Ok(SshTransport::Jump {
                stream: channel.into_stream(),
                jump,
            })
        }
        other => {
            let stream = establish_transport(host, port, other).await?;
            Ok(SshTransport::Tcp(stream))
        }
    }
}
