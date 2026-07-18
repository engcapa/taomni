//! Egress connectors: DIRECT, SOCKS5, HTTP CONNECT, SSH Jump scaffold.
//!
//! SOCKS5 / HTTP CONNECT reuse `crate::terminal::network::establish_transport`
//! so Sockscap does not fork a second handshake implementation. SSH Jump is
//! intentionally incomplete until known_hosts verification lands (design plan
//! §16.5 #19 / Phase 0 ADR open gate).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;

use crate::proxy::ResolvedProxy;
use crate::terminal::network::{establish_transport, NetworkSettings};

/// Target of an egress connect attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressTarget {
    /// Preferred hostname for remote DNS (proxy/SSH should resolve this).
    pub host: String,
    pub port: u16,
    /// Optional pre-resolved IP (used for DIRECT when host is empty).
    pub ip: Option<String>,
}

/// Non-sensitive metadata about how the connection was established.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressMetadata {
    pub connector: String,
    pub remote_dns: bool,
    pub tcp_only: bool,
    pub detail: String,
}

/// Result of a successful egress connect.
pub struct EgressStream {
    pub stream: TcpStream,
    pub meta: EgressMetadata,
}

impl std::fmt::Debug for EgressStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EgressStream")
            .field("meta", &self.meta)
            .field("stream", &"TcpStream")
            .finish()
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum EgressError {
    #[error("egress blocked by policy: {0}")]
    Blocked(String),
    #[error("egress not available: {0}")]
    Unavailable(String),
    #[error("connect failed: {0}")]
    Connect(String),
    /// SSH Jump cannot ship until host-key verification is real.
    #[error("SSH Jump blocked: host-key verification not implemented (release gate)")]
    SshHostKeyGate,
}

#[async_trait]
pub trait EgressConnector: Send + Sync {
    fn name(&self) -> &'static str;
    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError>;
}

/// Direct TCP to the original destination from the physical network.
pub struct DirectConnector;

#[async_trait]
impl EgressConnector for DirectConnector {
    fn name(&self) -> &'static str {
        "direct"
    }

    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError> {
        let host = if !target.host.is_empty() {
            target.host.as_str()
        } else if let Some(ip) = target.ip.as_deref() {
            ip
        } else {
            return Err(EgressError::Connect("direct: empty host and ip".into()));
        };
        let stream = establish_transport(host, target.port, None)
            .await
            .map_err(EgressError::Connect)?;
        Ok(EgressStream {
            stream,
            meta: EgressMetadata {
                connector: "direct".into(),
                remote_dns: false,
                tcp_only: false,
                detail: format!("direct {host}:{}", target.port),
            },
        })
    }
}

/// SOCKS5 via a resolved proxy session / manual endpoint.
pub struct Socks5Connector {
    pub proxy: ResolvedProxy,
}

#[async_trait]
impl EgressConnector for Socks5Connector {
    fn name(&self) -> &'static str {
        "socks5"
    }

    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError> {
        if self.proxy.kind != "socks5" {
            return Err(EgressError::Unavailable(format!(
                "Socks5Connector got kind={}",
                self.proxy.kind
            )));
        }
        let host = effective_host(target)?;
        let mut n = NetworkSettings::default();
        n.proxy_kind = "socks5".into();
        n.proxy_host = self.proxy.host.clone();
        n.proxy_port = self.proxy.port;
        n.proxy_user = self.proxy.username.clone();
        n.proxy_pass = self.proxy.password.clone();
        let stream = establish_transport(host, target.port, Some(&n))
            .await
            .map_err(EgressError::Connect)?;
        Ok(EgressStream {
            stream,
            meta: EgressMetadata {
                connector: "socks5".into(),
                remote_dns: true,
                tcp_only: false,
                detail: format!(
                    "socks5 {}@{}:{} → {host}:{}",
                    self.proxy.username,
                    self.proxy.host,
                    self.proxy.port,
                    target.port
                ),
            },
        })
    }
}

/// HTTP CONNECT via a resolved proxy session / manual endpoint.
pub struct HttpConnectConnector {
    pub proxy: ResolvedProxy,
}

#[async_trait]
impl EgressConnector for HttpConnectConnector {
    fn name(&self) -> &'static str {
        "http_connect"
    }

    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError> {
        if self.proxy.kind != "http" {
            return Err(EgressError::Unavailable(format!(
                "HttpConnectConnector got kind={}",
                self.proxy.kind
            )));
        }
        let host = effective_host(target)?;
        let mut n = NetworkSettings::default();
        n.proxy_kind = "http".into();
        n.proxy_host = self.proxy.host.clone();
        n.proxy_port = self.proxy.port;
        n.proxy_user = self.proxy.username.clone();
        n.proxy_pass = self.proxy.password.clone();
        let stream = establish_transport(host, target.port, Some(&n))
            .await
            .map_err(EgressError::Connect)?;
        Ok(EgressStream {
            stream,
            meta: EgressMetadata {
                connector: "http_connect".into(),
                remote_dns: true,
                tcp_only: true,
                detail: format!(
                    "http-connect {}@{}:{} → {host}:{}",
                    self.proxy.username,
                    self.proxy.host,
                    self.proxy.port,
                    target.port
                ),
            },
        })
    }
}

/// SSH Jump connector scaffold.
///
/// Design constraints (plan §4.3 / §16.5):
/// - One TCP flow → one `direct-tcpip` channel on a shared control connection
/// - known_hosts / fingerprint confirmation is a **release gate**
/// - Current `SshHandler::check_server_key` accepts all keys — must be fixed
///   before this connector may dial
///
/// Phase 2 returns [`EgressError::SshHostKeyGate`] until that gate is closed.
pub struct SshJumpConnector {
    pub session_id: String,
    /// When false (default), connect refuses with SshHostKeyGate.
    pub host_key_verification_ready: bool,
}

#[async_trait]
impl EgressConnector for SshJumpConnector {
    fn name(&self) -> &'static str {
        "ssh_jump"
    }

    async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
        if !self.host_key_verification_ready {
            return Err(EgressError::SshHostKeyGate);
        }
        // Future: SshChannelPool::open_direct_tcpip(target.host, target.port)
        Err(EgressError::Unavailable(format!(
            "SshChannelPool not implemented yet (session_id={})",
            self.session_id
        )))
    }
}

/// Build a connector from a resolved proxy kind string.
pub fn proxy_connector(proxy: ResolvedProxy) -> Result<Box<dyn EgressConnector>, EgressError> {
    match proxy.kind.as_str() {
        "socks5" => Ok(Box::new(Socks5Connector { proxy })),
        "http" => Ok(Box::new(HttpConnectConnector { proxy })),
        other => Err(EgressError::Unavailable(format!(
            "unsupported proxy kind '{other}'"
        ))),
    }
}

fn effective_host(target: &EgressTarget) -> Result<&str, EgressError> {
    if !target.host.is_empty() {
        Ok(target.host.as_str())
    } else if let Some(ip) = target.ip.as_deref() {
        Ok(ip)
    } else {
        Err(EgressError::Connect("empty host and ip".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn spawn_echo() -> (String, u16) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 64];
                if let Ok(n) = sock.read(&mut buf).await {
                    let _ = sock.write_all(&buf[..n]).await;
                }
            }
        });
        ("127.0.0.1".into(), port)
    }

    #[tokio::test]
    async fn direct_connector_echo() {
        let (host, port) = spawn_echo().await;
        let c = DirectConnector;
        let mut eg = c
            .connect(&EgressTarget {
                host: host.clone(),
                port,
                ip: None,
            })
            .await
            .expect("direct connect");
        eg.stream.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        eg.stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ping");
        assert_eq!(eg.meta.connector, "direct");
    }

    #[tokio::test]
    async fn ssh_jump_blocked_by_host_key_gate() {
        let c = SshJumpConnector {
            session_id: "ssh-1".into(),
            host_key_verification_ready: false,
        };
        let err = c
            .connect(&EgressTarget {
                host: "example.com".into(),
                port: 443,
                ip: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, EgressError::SshHostKeyGate));
    }

    #[tokio::test]
    async fn proxy_connector_kind_dispatch() {
        let socks = proxy_connector(ResolvedProxy {
            kind: "socks5".into(),
            host: "127.0.0.1".into(),
            port: 1080,
            username: String::new(),
            password: String::new(),
        })
        .unwrap();
        assert_eq!(socks.name(), "socks5");

        let http = proxy_connector(ResolvedProxy {
            kind: "http".into(),
            host: "127.0.0.1".into(),
            port: 8080,
            username: String::new(),
            password: String::new(),
        })
        .unwrap();
        assert_eq!(http.name(), "http_connect");
    }
}
