//! Protocol-neutral egress connectors for DIRECT, SOCKS5, HTTP CONNECT, and
//! SSH Jump.
//!
//! Successful connectors return a boxed bidirectional byte stream so the
//! FlowEngine can later carry either a `TcpStream` or an SSH `direct-tcpip`
//! channel without knowing the concrete transport type.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

use super::bypass::BypassEndpoint;
use crate::proxy::ResolvedProxy;
use crate::sockscap::policy::rules::normalize_hostname;
use crate::sockscap::types::SshPoolOptions;
use crate::terminal::network::{NetworkSettings, establish_transport};
use crate::terminal::ssh_pool::{
    SshChannelPool, SshConnectionFactory, SshDirectTcpipTarget, SshPoolConfig, SshPoolError,
    SshPoolKey, SshPoolSnapshot,
};

/// Target of an egress connect attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressTarget {
    /// Preferred hostname for remote resolution. Empty means use `ip`.
    pub host: String,
    pub port: u16,
    pub ip: Option<String>,
}

/// Non-sensitive metadata describing the established transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressMetadata {
    pub connector: String,
    pub remote_dns: bool,
    pub tcp_only: bool,
    /// Deliberately excludes destination hostname, username, and credentials.
    pub detail: String,
}

pub trait AsyncEgressStream: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T> AsyncEgressStream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

pub type BoxedEgressStream = Box<dyn AsyncEgressStream>;

/// Result of a successful egress connect.
pub struct EgressStream {
    pub stream: BoxedEgressStream,
    pub meta: EgressMetadata,
}

impl std::fmt::Debug for EgressStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EgressStream")
            .field("meta", &self.meta)
            .field("stream", &"bidirectional stream")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EgressError {
    #[error("egress not available: {0}")]
    Unavailable(String),
    #[error("invalid egress target: {0}")]
    InvalidTarget(String),
    #[error("connect failed: {0}")]
    Connect(String),
    #[error("{connector} connect timed out after {timeout_ms} ms")]
    Timeout { connector: String, timeout_ms: u64 },
    #[error("{connector} connect cancelled")]
    Cancelled { connector: String },
    #[error("{connector} requires user action ({action_code})")]
    UserActionRequired {
        connector: String,
        action_code: String,
    },
}

impl EgressError {
    /// Stable, non-sensitive value suitable for aggregate statistics.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable(_) => "unavailable",
            Self::InvalidTarget(_) => "invalid_target",
            Self::Connect(_) => "connect_failed",
            Self::Timeout { .. } => "timeout",
            Self::Cancelled { .. } => "cancelled",
            Self::UserActionRequired { .. } => "user_action_required",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UdpEgressCapability {
    Unsupported,
    /// The protocol can support UDP, but the configured server has not passed
    /// the probe and no forwarding association is active yet.
    ProbeRequired,
    Supported,
}

#[async_trait]
pub trait EgressConnector: Send + Sync {
    fn name(&self) -> &'static str;

    fn udp_capability(&self) -> UdpEgressCapability {
        UdpEgressCapability::Unsupported
    }

    fn upstream_endpoint(&self) -> Option<BypassEndpoint> {
        None
    }

    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError>;
}

/// Deadline and cancellation boundary for one connect attempt.
#[derive(Debug, Clone)]
pub struct ConnectControl {
    pub timeout: Duration,
    pub cancellation: CancellationToken,
}

impl ConnectControl {
    pub fn new(timeout: Duration, cancellation: CancellationToken) -> Self {
        Self {
            timeout,
            cancellation,
        }
    }
}

/// Run any connector under a deadline and cancellation token. Dropping the
/// losing future aborts DNS/TCP/proxy handshakes without spawning detached work.
pub async fn connect_controlled(
    connector: &dyn EgressConnector,
    target: &EgressTarget,
    control: &ConnectControl,
) -> Result<EgressStream, EgressError> {
    let name = connector.name().to_string();
    tokio::select! {
        biased;
        _ = control.cancellation.cancelled() => Err(EgressError::Cancelled { connector: name }),
        result = tokio::time::timeout(control.timeout, connector.connect(target)) => {
            match result {
                Ok(result) => result,
                Err(_) => Err(EgressError::Timeout {
                    connector: name,
                    timeout_ms: control.timeout.as_millis().min(u64::MAX as u128) as u64,
                }),
            }
        }
    }
}

/// Direct TCP to the original destination from the physical network.
#[derive(Debug, Default)]
pub struct DirectConnector;

#[async_trait]
impl EgressConnector for DirectConnector {
    fn name(&self) -> &'static str {
        "direct"
    }

    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError> {
        let effective = validate_target(target)?;
        // DIRECT must preserve the capture adapter's original destination IP
        // when one is available; re-resolving an attributed hostname could
        // change the endpoint or create an avoidable DNS leak.
        let direct_host = target
            .ip
            .as_deref()
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
            .map(|ip| ip.to_string())
            .unwrap_or(effective.host);
        let stream = establish_transport(&direct_host, target.port, None)
            .await
            .map_err(EgressError::Connect)?;
        Ok(EgressStream {
            stream: Box::new(stream),
            meta: EgressMetadata {
                connector: "direct".into(),
                remote_dns: false,
                tcp_only: false,
                detail: "direct TCP connection established".into(),
            },
        })
    }
}

struct ProxyConfig {
    kind: String,
    host: String,
    port: u16,
    username: String,
    password: Zeroizing<String>,
}

impl ProxyConfig {
    fn from_resolved(proxy: ResolvedProxy) -> Result<Self, EgressError> {
        let host = canonical_network_host(&proxy.host).ok_or_else(|| {
            EgressError::Unavailable("proxy endpoint has an invalid hostname or IP".into())
        })?;
        if proxy.port == 0 {
            return Err(EgressError::Unavailable(
                "proxy endpoint port must be non-zero".into(),
            ));
        }
        Ok(Self {
            kind: proxy.kind,
            host,
            port: proxy.port,
            username: proxy.username,
            password: Zeroizing::new(proxy.password),
        })
    }

    async fn connect(
        &self,
        target: &ValidatedTarget,
    ) -> Result<tokio::net::TcpStream, EgressError> {
        let mut network = NetworkSettings::default();
        network.proxy_kind = self.kind.clone();
        network.proxy_host = self.host.clone();
        network.proxy_port = self.port;
        network.proxy_user = self.username.clone();
        network.proxy_pass = self.password.as_str().to_owned();
        let network = SecretNetworkSettings(network);

        establish_transport(&target.host, target.port, Some(&network.0))
            .await
            .map_err(EgressError::Connect)
    }

    fn endpoint(&self) -> BypassEndpoint {
        BypassEndpoint {
            host: self.host.clone(),
            port: Some(self.port),
        }
    }
}

/// Zeroize the transient password clone even when timeout/cancellation drops
/// the connect future before its handshake completes.
struct SecretNetworkSettings(NetworkSettings);

impl Drop for SecretNetworkSettings {
    fn drop(&mut self) {
        self.0.proxy_pass.zeroize();
    }
}

impl std::fmt::Debug for ProxyConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProxyConfig")
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("has_auth", &!self.username.is_empty())
            .finish()
    }
}

/// SOCKS5 CONNECT via a resolved proxy session / manual endpoint.
#[derive(Debug)]
pub struct Socks5Connector {
    proxy: ProxyConfig,
}

#[async_trait]
impl EgressConnector for Socks5Connector {
    fn name(&self) -> &'static str {
        "socks5"
    }

    fn udp_capability(&self) -> UdpEgressCapability {
        // UDP ASSOCIATE needs an explicit server probe and forwarding data path.
        UdpEgressCapability::ProbeRequired
    }

    fn upstream_endpoint(&self) -> Option<BypassEndpoint> {
        Some(self.proxy.endpoint())
    }

    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError> {
        let target = validate_target(target)?;
        let stream = self.proxy.connect(&target).await?;
        Ok(EgressStream {
            stream: Box::new(stream),
            meta: EgressMetadata {
                connector: "socks5".into(),
                remote_dns: target.remote_dns,
                // This stream is TCP; UDP stays gated until ASSOCIATE succeeds.
                tcp_only: true,
                detail: "SOCKS5 CONNECT established".into(),
            },
        })
    }
}

/// HTTP CONNECT via a resolved proxy session / manual endpoint.
#[derive(Debug)]
pub struct HttpConnectConnector {
    proxy: ProxyConfig,
}

#[async_trait]
impl EgressConnector for HttpConnectConnector {
    fn name(&self) -> &'static str {
        "http_connect"
    }

    fn upstream_endpoint(&self) -> Option<BypassEndpoint> {
        Some(self.proxy.endpoint())
    }

    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError> {
        let target = validate_target(target)?;
        let stream = self.proxy.connect(&target).await?;
        Ok(EgressStream {
            stream: Box::new(stream),
            meta: EgressMetadata {
                connector: "http_connect".into(),
                remote_dns: target.remote_dns,
                tcp_only: true,
                detail: "HTTP CONNECT established".into(),
            },
        })
    }
}

/// SSH Jump connector backed by the shared, bounded control-connection pool.
pub struct SshJumpConnector {
    pool: Arc<SshChannelPool>,
    key: SshPoolKey,
    factory: Arc<dyn SshConnectionFactory>,
    lifecycle: CancellationToken,
}

impl SshJumpConnector {
    pub fn from_pool(
        pool: Arc<SshChannelPool>,
        key: SshPoolKey,
        factory: Arc<dyn SshConnectionFactory>,
        lifecycle: CancellationToken,
    ) -> Self {
        Self {
            pool,
            key,
            factory,
            lifecycle,
        }
    }

    pub async fn warm_up(&self) -> Result<(), EgressError> {
        self.pool
            .warm_up(&self.key, self.factory.as_ref(), &self.lifecycle)
            .await
            .map_err(|error| map_ssh_pool_error(error, self.pool.connect_timeout()))
    }

    pub fn snapshot(&self) -> SshPoolSnapshot {
        self.pool.snapshot()
    }
}

impl std::fmt::Debug for SshJumpConnector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshJumpConnector")
            .field("pool", &self.pool)
            .field("key", &self.key)
            .field("cancelled", &self.lifecycle.is_cancelled())
            .finish()
    }
}

#[async_trait]
impl EgressConnector for SshJumpConnector {
    fn name(&self) -> &'static str {
        "ssh_jump"
    }

    fn upstream_endpoint(&self) -> Option<BypassEndpoint> {
        Some(BypassEndpoint {
            host: self.key.host().to_string(),
            port: Some(self.key.port()),
        })
    }

    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError> {
        let target = validate_target(target)?;
        let ssh_target = SshDirectTcpipTarget::new(&target.host, target.port)
            .map_err(|error| map_ssh_pool_error(error, self.pool.connect_timeout()))?;
        let stream = self
            .pool
            .open_direct_tcpip(
                &self.key,
                self.factory.as_ref(),
                &ssh_target,
                &self.lifecycle,
            )
            .await
            .map_err(|error| map_ssh_pool_error(error, self.pool.connect_timeout()))?;
        Ok(EgressStream {
            stream: Box::new(stream),
            meta: EgressMetadata {
                connector: "ssh_jump".into(),
                remote_dns: target.remote_dns,
                tcp_only: true,
                detail: "SSH direct-tcpip channel established".into(),
            },
        })
    }
}

/// Translate profile-owned, non-sensitive settings into the shared pool's
/// bounded runtime configuration.
pub fn ssh_pool_config(options: &SshPoolOptions) -> Result<SshPoolConfig, EgressError> {
    let mut config = SshPoolConfig::default();
    config.max_control_connections = usize::from(options.max_control_connections);
    config.max_channels_per_connection = usize::try_from(options.max_channels_per_connection)
        .map_err(|_| EgressError::Unavailable("SSH channel limit is not supported".into()))?;
    config.keepalive_interval = Duration::from_secs(options.keepalive_seconds);
    config.connect_timeout = Duration::from_secs(options.connect_timeout_seconds);
    config
        .validate()
        .map_err(|error| EgressError::Unavailable(error.to_string()))?;
    Ok(config)
}

fn map_ssh_pool_error(error: SshPoolError, connect_timeout: Duration) -> EgressError {
    match error {
        SshPoolError::InvalidTarget(message) => EgressError::InvalidTarget(message),
        SshPoolError::Timeout { .. } => EgressError::Timeout {
            connector: "ssh_jump".into(),
            timeout_ms: connect_timeout.as_millis().min(u64::MAX as u128) as u64,
        },
        SshPoolError::Cancelled => EgressError::Cancelled {
            connector: "ssh_jump".into(),
        },
        SshPoolError::UserActionRequired { code, .. } => EgressError::UserActionRequired {
            connector: "ssh_jump".into(),
            action_code: code,
        },
        SshPoolError::Closed => EgressError::Unavailable("SSH channel pool is stopped".to_string()),
        SshPoolError::InvalidConfig(message) | SshPoolError::InvalidKey(message) => {
            EgressError::Unavailable(message)
        }
        SshPoolError::Connect(message) | SshPoolError::ChannelOpen(message) => {
            EgressError::Connect(message)
        }
    }
}

/// Build a validated, shared connector from a fully resolved proxy. Plaintext
/// credentials move into zeroizing connector-owned memory and are never copied
/// into metadata or debug output.
pub fn proxy_connector(proxy: ResolvedProxy) -> Result<Arc<dyn EgressConnector>, EgressError> {
    match proxy.kind.as_str() {
        "socks5" => Ok(Arc::new(Socks5Connector {
            proxy: ProxyConfig::from_resolved(proxy)?,
        })),
        "http" => Ok(Arc::new(HttpConnectConnector {
            proxy: ProxyConfig::from_resolved(proxy)?,
        })),
        other => Err(EgressError::Unavailable(format!(
            "unsupported proxy kind '{other}'"
        ))),
    }
}

#[derive(Debug)]
struct ValidatedTarget {
    host: String,
    port: u16,
    remote_dns: bool,
}

fn validate_target(target: &EgressTarget) -> Result<ValidatedTarget, EgressError> {
    if target.port == 0 {
        return Err(EgressError::InvalidTarget(
            "destination port must be non-zero".into(),
        ));
    }

    let preferred = target.host.trim();
    let (host, remote_dns) = if !preferred.is_empty() {
        if let Ok(ip) = preferred.parse::<IpAddr>() {
            (ip.to_string(), false)
        } else {
            let host = normalize_hostname(preferred).ok_or_else(|| {
                EgressError::InvalidTarget("destination hostname is invalid".into())
            })?;
            (host, true)
        }
    } else {
        let ip = target
            .ip
            .as_deref()
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
            .ok_or_else(|| {
                EgressError::InvalidTarget("destination hostname and IP are missing".into())
            })?;
        (ip.to_string(), false)
    };

    Ok(ValidatedTarget {
        host,
        port: target.port,
        remote_dns,
    })
}

fn canonical_network_host(input: &str) -> Option<String> {
    let input = input.trim();
    let unbracketed = input
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(input);
    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return Some(ip.to_string());
    }
    normalize_hostname(unbracketed)
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use base64::Engine as _;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    async fn spawn_echo() -> (String, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0; 64];
                if let Ok(size) = socket.read(&mut buffer).await {
                    let _ = socket.write_all(&buffer[..size]).await;
                }
            }
        });
        ("127.0.0.1".into(), port)
    }

    async fn spawn_socks5_auth_server() -> (
        u16,
        tokio::sync::oneshot::Receiver<(String, String, String, u16)>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut greeting = [0; 2];
            socket.read_exact(&mut greeting).await.unwrap();
            let mut methods = vec![0; greeting[1] as usize];
            socket.read_exact(&mut methods).await.unwrap();
            socket.write_all(&[5, 2]).await.unwrap();

            let mut auth = [0; 2];
            socket.read_exact(&mut auth).await.unwrap();
            let mut username = vec![0; auth[1] as usize];
            socket.read_exact(&mut username).await.unwrap();
            let mut password_len = [0];
            socket.read_exact(&mut password_len).await.unwrap();
            let mut password = vec![0; password_len[0] as usize];
            socket.read_exact(&mut password).await.unwrap();
            socket.write_all(&[1, 0]).await.unwrap();

            let mut request = [0; 4];
            socket.read_exact(&mut request).await.unwrap();
            assert_eq!(&request[..3], &[5, 1, 0]);
            let host = match request[3] {
                1 => {
                    let mut octets = [0; 4];
                    socket.read_exact(&mut octets).await.unwrap();
                    std::net::Ipv4Addr::from(octets).to_string()
                }
                3 => {
                    let mut len = [0];
                    socket.read_exact(&mut len).await.unwrap();
                    let mut value = vec![0; len[0] as usize];
                    socket.read_exact(&mut value).await.unwrap();
                    String::from_utf8(value).unwrap()
                }
                other => panic!("unexpected SOCKS address type {other}"),
            };
            let mut destination_port = [0; 2];
            socket.read_exact(&mut destination_port).await.unwrap();
            socket
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 1])
                .await
                .unwrap();
            let _ = sender.send((
                String::from_utf8(username).unwrap(),
                String::from_utf8(password).unwrap(),
                host,
                u16::from_be_bytes(destination_port),
            ));
        });
        (port, receiver)
    }

    async fn spawn_http_connect_server() -> (u16, tokio::sync::oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while request.len() <= 8192 && !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            let _ = sender.send(String::from_utf8(request).unwrap());
        });
        (port, receiver)
    }

    fn proxy(kind: &str, port: u16) -> ResolvedProxy {
        ResolvedProxy {
            kind: kind.into(),
            host: "127.0.0.1".into(),
            port,
            username: "alice".into(),
            password: "s3cret".into(),
        }
    }

    #[tokio::test]
    async fn direct_connector_returns_a_polymorphic_echo_stream() {
        let (host, port) = spawn_echo().await;
        let connector = DirectConnector;
        let mut egress = connector
            .connect(&EgressTarget {
                host,
                port,
                ip: None,
            })
            .await
            .unwrap();
        egress.stream.write_all(b"ping").await.unwrap();
        let mut buffer = [0; 4];
        egress.stream.read_exact(&mut buffer).await.unwrap();
        assert_eq!(&buffer, b"ping");
        assert_eq!(egress.meta.connector, "direct");
    }

    #[tokio::test]
    async fn direct_connector_prefers_the_original_destination_ip() {
        let (_host, port) = spawn_echo().await;
        let connector = DirectConnector;
        let egress = connector
            .connect(&EgressTarget {
                host: "must-not-resolve.invalid".into(),
                port,
                ip: Some("127.0.0.1".into()),
            })
            .await
            .unwrap();
        assert_eq!(egress.meta.connector, "direct");
    }

    #[tokio::test]
    async fn socks5_auth_and_remote_dns_are_exercised_locally() {
        let (port, observed) = spawn_socks5_auth_server().await;
        let connector = proxy_connector(proxy("socks5", port)).unwrap();
        let egress = connector
            .connect(&EgressTarget {
                host: "BÜCHER.example".into(),
                port: 443,
                ip: None,
            })
            .await
            .unwrap();
        assert_eq!(
            observed.await.unwrap(),
            (
                "alice".into(),
                "s3cret".into(),
                "xn--bcher-kva.example".into(),
                443
            )
        );
        assert!(egress.meta.remote_dns);
        assert!(egress.meta.tcp_only);
        let metadata = serde_json::to_string(&egress.meta).unwrap();
        assert!(!metadata.contains("alice"));
        assert!(!metadata.contains("s3cret"));
    }

    #[tokio::test]
    async fn http_connect_auth_is_exercised_without_metadata_leakage() {
        let (port, observed) = spawn_http_connect_server().await;
        let connector = proxy_connector(proxy("http", port)).unwrap();
        let egress = connector
            .connect(&EgressTarget {
                host: "target.example".into(),
                port: 8443,
                ip: None,
            })
            .await
            .unwrap();
        let request = observed.await.unwrap();
        assert!(request.starts_with("CONNECT target.example:8443 HTTP/1.1\r\n"));
        let auth = base64::engine::general_purpose::STANDARD.encode("alice:s3cret");
        assert!(request.contains(&format!("Proxy-Authorization: Basic {auth}")));
        let metadata = serde_json::to_string(&egress.meta).unwrap();
        assert!(!metadata.contains("alice"));
        assert!(!metadata.contains("s3cret"));
    }

    #[tokio::test]
    async fn http_connect_brackets_ipv6_authorities() {
        let (port, observed) = spawn_http_connect_server().await;
        let connector = proxy_connector(proxy("http", port)).unwrap();
        let egress = connector
            .connect(&EgressTarget {
                host: "2001:db8::8".into(),
                port: 8443,
                ip: None,
            })
            .await
            .unwrap();
        let request = observed.await.unwrap();
        assert!(request.starts_with("CONNECT [2001:db8::8]:8443 HTTP/1.1\r\n"));
        assert!(!egress.meta.remote_dns);
    }

    #[test]
    fn proxy_factory_rejects_invalid_or_unsupported_endpoints() {
        assert!(proxy_connector(proxy("socks4", 1080)).is_err());
        let mut invalid = proxy("http", 0);
        invalid.host = "bad host".into();
        assert!(proxy_connector(invalid).is_err());
    }

    #[test]
    fn target_validation_rejects_zero_port_and_invalid_hostname() {
        assert!(
            validate_target(&EgressTarget {
                host: "example.com".into(),
                port: 0,
                ip: None,
            })
            .is_err()
        );
        assert!(
            validate_target(&EgressTarget {
                host: "bad host".into(),
                port: 443,
                ip: Some("192.0.2.1".into()),
            })
            .is_err()
        );
    }

    struct PendingConnector;

    #[async_trait]
    impl EgressConnector for PendingConnector {
        fn name(&self) -> &'static str {
            "pending"
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            pending().await
        }
    }

    fn inert_target() -> EgressTarget {
        EgressTarget {
            host: "example.test".into(),
            port: 443,
            ip: None,
        }
    }

    #[tokio::test]
    async fn connect_deadline_is_enforced() {
        let error = connect_controlled(
            &PendingConnector,
            &inert_target(),
            &ConnectControl::new(Duration::from_millis(5), CancellationToken::new()),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, EgressError::Timeout { .. }));
    }

    #[tokio::test]
    async fn pre_cancelled_connect_never_starts() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let error = connect_controlled(
            &PendingConnector,
            &inert_target(),
            &ConnectControl::new(Duration::from_secs(1), cancellation),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, EgressError::Cancelled { .. }));
    }

    #[derive(Default)]
    struct RecordingSshControl {
        targets: StdMutex<Vec<(String, u16)>>,
    }

    #[async_trait]
    impl crate::terminal::ssh_pool::SshControlConnection for RecordingSshControl {
        fn is_closed(&self) -> bool {
            false
        }

        async fn open_direct_tcpip(
            &self,
            target: &SshDirectTcpipTarget,
        ) -> Result<
            crate::terminal::ssh_pool::BoxedSshChannelStream,
            crate::terminal::ssh_pool::ControlOpenError,
        > {
            self.targets
                .lock()
                .unwrap()
                .push((target.host().to_string(), target.port()));
            let (stream, peer) = tokio::io::duplex(64);
            tokio::spawn(async move {
                pending::<()>().await;
                drop(peer);
            });
            Ok(Box::new(stream))
        }
    }

    struct RecordingSshFactory {
        control: Arc<RecordingSshControl>,
        connects: AtomicUsize,
    }

    #[async_trait]
    impl SshConnectionFactory for RecordingSshFactory {
        async fn connect(
            &self,
            _key: &SshPoolKey,
            _keepalive_interval: Duration,
        ) -> Result<Arc<dyn crate::terminal::ssh_pool::SshControlConnection>, SshPoolError>
        {
            self.connects.fetch_add(1, Ordering::AcqRel);
            Ok(self.control.clone())
        }
    }

    #[tokio::test]
    async fn ssh_jump_uses_remote_dns_and_shared_pool() {
        let config = ssh_pool_config(&SshPoolOptions {
            max_control_connections: 1,
            max_channels_per_connection: 2,
            keepalive_seconds: 15,
            connect_timeout_seconds: 2,
        })
        .unwrap();
        let pool = Arc::new(SshChannelPool::new(config).unwrap());
        let control = Arc::new(RecordingSshControl::default());
        let factory = Arc::new(RecordingSshFactory {
            control: control.clone(),
            connects: AtomicUsize::new(0),
        });
        let key = SshPoolKey::new("session:ssh-1", "SSH.EXAMPLE.", 22, "private-user").unwrap();
        let connector =
            SshJumpConnector::from_pool(pool, key, factory.clone(), CancellationToken::new());

        connector.warm_up().await.unwrap();
        let egress = connector
            .connect(&EgressTarget {
                host: "BÜCHER.example".into(),
                port: 443,
                ip: Some("192.0.2.1".into()),
            })
            .await
            .unwrap();

        assert_eq!(factory.connects.load(Ordering::Acquire), 1);
        assert_eq!(
            control.targets.lock().unwrap().as_slice(),
            &[("xn--bcher-kva.example".into(), 443)]
        );
        assert_eq!(
            connector.upstream_endpoint(),
            Some(BypassEndpoint {
                host: "ssh.example".into(),
                port: Some(22),
            })
        );
        assert!(egress.meta.remote_dns);
        assert!(egress.meta.tcp_only);
        assert_eq!(connector.snapshot().active_channels, 1);
        drop(egress);
        assert_eq!(connector.snapshot().active_channels, 0);
    }
}
