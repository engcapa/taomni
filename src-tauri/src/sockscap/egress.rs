//! Egress connectors (plan §4.3).
//!
//! FlowEngine is protocol-agnostic: it holds an [`EgressConnector`] and calls
//! `connect_tcp`, getting back a boxed byte stream plus [`EgressMetadata`] (which
//! upstream, how DNS was resolved) for the dashboard. TCP egress reuses the
//! app's proven proxy-client handshakes in `terminal::network` rather than
//! re-implementing SOCKS5 / HTTP CONNECT. The SSH-jump connector lives in
//! `ssh_pool.rs` and plugs into the same trait.

use std::net::IpAddr;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::terminal::network::{establish_transport, NetworkSettings};

/// A connected, bidirectional egress byte stream (blanket-implemented).
pub trait EgressStream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> EgressStream for T {}

/// A boxed egress stream, the uniform type FlowEngine bridges to the captured
/// client socket.
pub type BoxedEgressStream = Box<dyn EgressStream>;

/// The destination of a flow.
#[derive(Debug, Clone)]
pub struct Endpoint {
    /// Hostname to hand to the upstream for remote resolution, when known.
    pub host: Option<String>,
    /// Destination IP, when that's all we have.
    pub ip: Option<IpAddr>,
    pub port: u16,
}

impl Endpoint {
    pub fn from_host(host: impl Into<String>, port: u16) -> Endpoint {
        Endpoint {
            host: Some(host.into()),
            ip: None,
            port,
        }
    }

    pub fn from_ip(ip: IpAddr, port: u16) -> Endpoint {
        Endpoint {
            host: None,
            ip: Some(ip),
            port,
        }
    }

    /// The address to hand the upstream: prefer the hostname (so DNS resolves at
    /// the proxy / SSH remote, per plan §4/§6.4) and fall back to the IP.
    pub fn connect_host(&self) -> Result<String, String> {
        self.host
            .clone()
            .or_else(|| self.ip.map(|i| i.to_string()))
            .ok_or_else(|| "endpoint has neither host nor ip".to_string())
    }

    /// True when only an IP (no hostname) is available.
    pub fn is_ip_only(&self) -> bool {
        self.host.is_none() && self.ip.is_some()
    }
}

/// How the destination hostname was resolved for this egress (surfaced in the
/// UI, e.g. "DNS: SSH remote" — plan §4.3, §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DnsResolution {
    LocalDirect,
    RemoteSocks5,
    RemoteHttpConnect,
    SshRemote,
    IpOnly,
}

/// Which egress family handled a flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressKindLabel {
    Direct,
    Socks5,
    HttpConnect,
    SshJump,
}

/// Metadata about how a flow egressed, for the dashboard (no payload).
#[derive(Debug, Clone)]
pub struct EgressMetadata {
    pub kind: EgressKindLabel,
    pub dns: DnsResolution,
    /// Configured upstream endpoint (`host:port`), for telemetry and so the
    /// engine can hard-bypass it. `None` for direct.
    pub upstream: Option<String>,
}

/// The uniform egress interface FlowEngine depends on (plan §4.3).
#[async_trait]
pub trait EgressConnector: Send + Sync {
    /// Open a TCP flow to `target`, returning the stream and metadata. A
    /// TCP-only upstream (HTTP CONNECT / SSH) never claims UDP support — UDP is
    /// handled by the policy layer, not here.
    async fn connect_tcp(
        &self,
        target: &Endpoint,
    ) -> Result<(BoxedEgressStream, EgressMetadata), String>;

    fn label(&self) -> EgressKindLabel;
}

/// Direct egress from the physical network (plan §4.3 DirectConnector).
pub struct DirectConnector;

#[async_trait]
impl EgressConnector for DirectConnector {
    async fn connect_tcp(
        &self,
        target: &Endpoint,
    ) -> Result<(BoxedEgressStream, EgressMetadata), String> {
        let host = target.connect_host()?;
        let stream = establish_transport(&host, target.port, None).await?;
        let dns = if target.is_ip_only() {
            DnsResolution::IpOnly
        } else {
            DnsResolution::LocalDirect
        };
        Ok((
            Box::new(stream),
            EgressMetadata {
                kind: EgressKindLabel::Direct,
                dns,
                upstream: None,
            },
        ))
    }

    fn label(&self) -> EgressKindLabel {
        EgressKindLabel::Direct
    }
}

/// A proxy upstream (SOCKS5 or HTTP CONNECT), resolved from a saved Proxy
/// session. Secrets are resolved from Vault by the caller before construction;
/// this struct only holds what a connect needs.
#[derive(Debug, Clone)]
pub struct ProxyUpstream {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
}

impl ProxyUpstream {
    fn to_network(&self, kind: &str) -> NetworkSettings {
        NetworkSettings {
            proxy_kind: kind.to_string(),
            proxy_host: self.host.clone(),
            proxy_port: self.port,
            proxy_user: self.user.clone(),
            proxy_pass: self.pass.clone(),
            ..Default::default()
        }
    }

    fn endpoint_label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// SOCKS5 upstream connector (plan §4.3 Socks5Connector). Hands the destination
/// hostname to the proxy for remote resolution when available.
pub struct Socks5Connector {
    pub upstream: ProxyUpstream,
}

#[async_trait]
impl EgressConnector for Socks5Connector {
    async fn connect_tcp(
        &self,
        target: &Endpoint,
    ) -> Result<(BoxedEgressStream, EgressMetadata), String> {
        let host = target.connect_host()?;
        let net = self.upstream.to_network("socks5");
        let stream = establish_transport(&host, target.port, Some(&net)).await?;
        let dns = if target.is_ip_only() {
            DnsResolution::IpOnly
        } else {
            DnsResolution::RemoteSocks5
        };
        Ok((
            Box::new(stream),
            EgressMetadata {
                kind: EgressKindLabel::Socks5,
                dns,
                upstream: Some(self.upstream.endpoint_label()),
            },
        ))
    }

    fn label(&self) -> EgressKindLabel {
        EgressKindLabel::Socks5
    }
}

/// HTTP CONNECT upstream connector (plan §4.3 HttpConnectConnector). TCP only —
/// UDP/QUIC is decided by the policy layer, never smuggled here (plan §7).
pub struct HttpConnectConnector {
    pub upstream: ProxyUpstream,
}

#[async_trait]
impl EgressConnector for HttpConnectConnector {
    async fn connect_tcp(
        &self,
        target: &Endpoint,
    ) -> Result<(BoxedEgressStream, EgressMetadata), String> {
        let host = target.connect_host()?;
        let net = self.upstream.to_network("http");
        let stream = establish_transport(&host, target.port, Some(&net)).await?;
        let dns = if target.is_ip_only() {
            DnsResolution::IpOnly
        } else {
            DnsResolution::RemoteHttpConnect
        };
        Ok((
            Box::new(stream),
            EgressMetadata {
                kind: EgressKindLabel::HttpConnect,
                dns,
                upstream: Some(self.upstream.endpoint_label()),
            },
        ))
    }

    fn label(&self) -> EgressKindLabel {
        EgressKindLabel::HttpConnect
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Spawn a one-shot TCP echo server; returns its bound port.
    async fn spawn_echo() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
        port
    }

    #[tokio::test]
    async fn direct_connector_round_trips_bytes() {
        let port = spawn_echo().await;
        let c = DirectConnector;
        let (mut s, meta) = c
            .connect_tcp(&Endpoint::from_ip("127.0.0.1".parse().unwrap(), port))
            .await
            .unwrap();
        assert_eq!(meta.kind, EgressKindLabel::Direct);
        assert_eq!(meta.dns, DnsResolution::IpOnly);
        s.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ping");
    }

    /// Minimal SOCKS5 server: no-auth, accepts one CONNECT, then echoes. Does
    /// not actually connect onward — it validates the client handshake and the
    /// stream plumbing end-to-end.
    async fn spawn_socks5() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            // Greeting: VER, NMETHODS, methods.
            let mut head = [0u8; 2];
            s.read_exact(&mut head).await.unwrap();
            let mut methods = vec![0u8; head[1] as usize];
            s.read_exact(&mut methods).await.unwrap();
            s.write_all(&[0x05, 0x00]).await.unwrap(); // select no-auth
            // Request: VER, CMD, RSV, ATYP, addr, port.
            let mut req = [0u8; 4];
            s.read_exact(&mut req).await.unwrap();
            match req[3] {
                0x01 => {
                    let mut a = [0u8; 4];
                    s.read_exact(&mut a).await.unwrap();
                }
                0x03 => {
                    let mut len = [0u8; 1];
                    s.read_exact(&mut len).await.unwrap();
                    let mut host = vec![0u8; len[0] as usize];
                    s.read_exact(&mut host).await.unwrap();
                }
                0x04 => {
                    let mut a = [0u8; 16];
                    s.read_exact(&mut a).await.unwrap();
                }
                _ => panic!("bad ATYP"),
            }
            let mut p = [0u8; 2];
            s.read_exact(&mut p).await.unwrap();
            // Success reply with BND 0.0.0.0:0.
            s.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
            // Echo.
            let mut buf = [0u8; 1024];
            loop {
                match s.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if s.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
        port
    }

    #[tokio::test]
    async fn socks5_connector_handshakes_and_round_trips() {
        let proxy_port = spawn_socks5().await;
        let c = Socks5Connector {
            upstream: ProxyUpstream {
                host: "127.0.0.1".into(),
                port: proxy_port,
                user: String::new(),
                pass: String::new(),
            },
        };
        let (mut s, meta) = c
            .connect_tcp(&Endpoint::from_host("dest.example", 1234))
            .await
            .unwrap();
        assert_eq!(meta.kind, EgressKindLabel::Socks5);
        assert_eq!(meta.dns, DnsResolution::RemoteSocks5);
        assert!(meta.upstream.as_deref().unwrap().starts_with("127.0.0.1:"));
        s.write_all(b"hello").await.unwrap();
        let mut buf = [0u8; 5];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
    }

    /// Minimal HTTP CONNECT server: reads the request head, replies 200, echoes.
    async fn spawn_http_connect() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            // Read request head until CRLFCRLF.
            let mut acc: Vec<u8> = Vec::new();
            let mut b = [0u8; 1];
            while s.read_exact(&mut b).await.is_ok() {
                acc.push(b[0]);
                if acc.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            let mut buf = [0u8; 1024];
            loop {
                match s.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if s.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
        port
    }

    #[tokio::test]
    async fn http_connect_connector_handshakes_and_round_trips() {
        let proxy_port = spawn_http_connect().await;
        let c = HttpConnectConnector {
            upstream: ProxyUpstream {
                host: "127.0.0.1".into(),
                port: proxy_port,
                user: String::new(),
                pass: String::new(),
            },
        };
        let (mut s, meta) = c
            .connect_tcp(&Endpoint::from_host("dest.example", 443))
            .await
            .unwrap();
        assert_eq!(meta.kind, EgressKindLabel::HttpConnect);
        assert_eq!(meta.dns, DnsResolution::RemoteHttpConnect);
        s.write_all(b"quic-no").await.unwrap();
        let mut buf = [0u8; 7];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"quic-no");
    }
}
