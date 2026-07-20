//! Protocol-neutral egress connectors for DIRECT, SOCKS5, HTTP CONNECT, and
//! SSH Jump.
//!
//! Successful connectors return a boxed bidirectional byte stream so the
//! FlowEngine can later carry either a `TcpStream` or an SSH `direct-tcpip`
//! channel without knowing the concrete transport type.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Semaphore;
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

/// Largest UDP payloads representable by each IP family. Callers must retain
/// datagram boundaries and reject larger payloads before reaching the socket.
pub const MAX_IPV4_UDP_DATAGRAM_BYTES: usize = 65_507;
pub const MAX_IPV6_UDP_DATAGRAM_BYTES: usize = 65_527;
const UDP_RECEIVE_BUFFER_BYTES: usize = u16::MAX as usize;
const DEFAULT_DIRECT_UDP_RECEIVE_BUDGET_BYTES: usize = 16 * 1024 * 1024;
const MAX_DIRECT_UDP_RECEIVE_BUDGET_BYTES: usize = 256 * 1024 * 1024;

/// Object-safe, asynchronous I/O for one connected UDP association.
///
/// Each `send` and `receive` represents exactly one datagram. Implementations
/// must never split, merge, or silently truncate payloads. Both futures must be
/// cancellation-safe and must not detach work: dropping `receive` must not
/// consume a datagram, while dropping `send` must either leave the datagram
/// uncommitted or have completed its one atomic send. A cancelled future must
/// never deliver a datagram later. Returned receive allocations must be
/// bounded to a non-jumbo UDP datagram and must not hide attacker-controlled
/// spare capacity.
#[async_trait]
pub trait AsyncUdpAssociation: Send + Sync {
    async fn send(&self, datagram: Vec<u8>) -> Result<(), EgressError>;

    async fn receive(&self) -> Result<Vec<u8>, EgressError>;

    /// Idempotently close this association and interrupt pending I/O.
    ///
    /// This is a synchronous task-cancellation hook: it must complete in O(1),
    /// must never block on network, filesystem, thread, or actor progress, and
    /// must not start detached cleanup. Implementations should only close an
    /// owned local handle or signal an already-owned supervised actor.
    fn close(&self);

    fn is_closed(&self) -> bool;
}

pub type BoxedUdpAssociation = Box<dyn AsyncUdpAssociation>;

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

/// Result of a successful UDP association setup.
pub struct EgressUdpAssociation {
    pub association: BoxedUdpAssociation,
    pub meta: EgressMetadata,
}

impl std::fmt::Debug for EgressUdpAssociation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EgressUdpAssociation")
            .field("meta", &self.meta)
            .field("association", &"connected datagram association")
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

    /// Open a byte-stream transport. The future must be cancellation-safe and
    /// own no detached setup work: dropping it must synchronously drop every
    /// partially-created socket/session or leave cleanup with an already-owned
    /// supervised runtime owner.
    async fn connect(&self, target: &EgressTarget) -> Result<EgressStream, EgressError>;

    /// Open a datagram-preserving association. TCP-only connectors fail closed
    /// until they provide and probe a real UDP forwarding implementation. The
    /// future must be cancellation-safe and own no detached setup work:
    /// dropping it must synchronously drop every partially-created
    /// socket/session or leave cleanup with an already-owned supervised runtime
    /// owner.
    async fn connect_udp(
        &self,
        _target: &EgressTarget,
    ) -> Result<EgressUdpAssociation, EgressError> {
        Err(EgressError::Unavailable(format!(
            "{} UDP egress is unsupported",
            self.name()
        )))
    }
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

/// Run UDP association setup under the same owned cancellation and deadline
/// contract as TCP connects. The losing future is dropped immediately.
pub async fn connect_udp_controlled(
    connector: &dyn EgressConnector,
    target: &EgressTarget,
    control: &ConnectControl,
) -> Result<EgressUdpAssociation, EgressError> {
    let name = connector.name().to_string();
    tokio::select! {
        biased;
        _ = control.cancellation.cancelled() => Err(EgressError::Cancelled { connector: name }),
        result = tokio::time::timeout(control.timeout, connector.connect_udp(target)) => {
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
#[derive(Clone)]
pub struct DirectConnector {
    udp_receive_budget: Arc<Semaphore>,
    udp_receive_budget_bytes: usize,
}

impl DirectConnector {
    /// Build a DIRECT connector whose concurrently waiting UDP receive buffers
    /// have one shared hard byte ceiling. Each active receive reserves the
    /// full non-jumbo buffer before allocation; associations beyond the budget
    /// wait without allocating an untracked 64 KiB buffer.
    pub fn with_udp_receive_budget(max_bytes: usize) -> Result<Self, EgressError> {
        if max_bytes < UDP_RECEIVE_BUFFER_BYTES || max_bytes > MAX_DIRECT_UDP_RECEIVE_BUDGET_BYTES {
            return Err(EgressError::Unavailable(
                "direct UDP receive memory budget is outside the controlled range".into(),
            ));
        }
        Ok(Self {
            udp_receive_budget: Arc::new(Semaphore::new(max_bytes)),
            udp_receive_budget_bytes: max_bytes,
        })
    }

    pub fn udp_receive_budget_bytes(&self) -> usize {
        self.udp_receive_budget_bytes
    }
}

impl Default for DirectConnector {
    fn default() -> Self {
        Self::with_udp_receive_budget(DEFAULT_DIRECT_UDP_RECEIVE_BUDGET_BYTES)
            .expect("fixed direct UDP receive budget is valid")
    }
}

impl std::fmt::Debug for DirectConnector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DirectConnector")
            .field("udp_receive_budget_bytes", &self.udp_receive_budget_bytes)
            .field(
                "udp_receive_budget_available",
                &self.udp_receive_budget.available_permits(),
            )
            .finish()
    }
}

#[async_trait]
impl EgressConnector for DirectConnector {
    fn name(&self) -> &'static str {
        "direct"
    }

    fn udp_capability(&self) -> UdpEgressCapability {
        UdpEgressCapability::Supported
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

    async fn connect_udp(
        &self,
        target: &EgressTarget,
    ) -> Result<EgressUdpAssociation, EgressError> {
        let destination = original_udp_destination(target)?;
        let bind_address = udp_bind_address(destination.ip());
        let socket = tokio::net::UdpSocket::bind(bind_address)
            .await
            .map_err(|error| udp_io_error("bind", error))?;
        socket
            .connect(destination)
            .await
            .map_err(|error| udp_io_error("connect", error))?;

        Ok(EgressUdpAssociation {
            association: Box::new(DirectUdpAssociation {
                socket,
                max_datagram_bytes: max_udp_datagram_bytes(destination.ip()),
                closed: CancellationToken::new(),
                receive_budget: Arc::clone(&self.udp_receive_budget),
            }),
            meta: EgressMetadata {
                connector: "direct".into(),
                remote_dns: false,
                tcp_only: false,
                detail: "direct UDP association established".into(),
            },
        })
    }
}

struct DirectUdpAssociation {
    socket: tokio::net::UdpSocket,
    max_datagram_bytes: usize,
    closed: CancellationToken,
    receive_budget: Arc<Semaphore>,
}

impl std::fmt::Debug for DirectUdpAssociation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DirectUdpAssociation")
            .field("max_datagram_bytes", &self.max_datagram_bytes)
            .field("closed", &self.closed.is_cancelled())
            .finish()
    }
}

#[async_trait]
impl AsyncUdpAssociation for DirectUdpAssociation {
    async fn send(&self, datagram: Vec<u8>) -> Result<(), EgressError> {
        if self.closed.is_cancelled() {
            return Err(closed_udp_association_error());
        }
        if datagram.len() > self.max_datagram_bytes {
            return Err(EgressError::InvalidTarget(format!(
                "UDP datagram is {} bytes; maximum is {} bytes",
                datagram.len(),
                self.max_datagram_bytes
            )));
        }

        let sent = tokio::select! {
            biased;
            _ = self.closed.cancelled() => return Err(closed_udp_association_error()),
            result = self.socket.send(&datagram) => {
                result.map_err(|error| udp_io_error("send", error))?
            }
        };
        if sent != datagram.len() {
            return Err(EgressError::Connect(format!(
                "UDP send was incomplete: accepted {sent} of {} bytes",
                datagram.len()
            )));
        }
        Ok(())
    }

    async fn receive(&self) -> Result<Vec<u8>, EgressError> {
        if self.closed.is_cancelled() {
            return Err(closed_udp_association_error());
        }

        let receive_permit = tokio::select! {
            biased;
            _ = self.closed.cancelled() => return Err(closed_udp_association_error()),
            permit = Arc::clone(&self.receive_budget)
                .acquire_many_owned(UDP_RECEIVE_BUFFER_BYTES as u32) => {
                permit.map_err(|_| EgressError::Unavailable(
                    "direct UDP receive memory budget is closed".into()
                ))?
            }
        };
        // This exceeds the largest legal non-jumbo UDP payload for either
        // family, so a successful receive cannot have been truncated by our
        // buffer. Copy the used prefix into a tightly-sized return value before
        // releasing the global permit; small DNS packets must not retain a
        // hidden 64 KiB Vec capacity in downstream queues.
        let mut datagram = vec![0; UDP_RECEIVE_BUFFER_BYTES];
        let received = tokio::select! {
            biased;
            _ = self.closed.cancelled() => return Err(closed_udp_association_error()),
            result = self.socket.recv(&mut datagram) => {
                result.map_err(|error| udp_io_error("receive", error))?
            }
        };
        // The boxed-slice round trip makes the returned Vec's allocation match
        // the datagram length. `shrink_to_fit` alone is only a best-effort hint
        // and would not be a sufficient queue-memory invariant here.
        let result = datagram[..received].to_vec().into_boxed_slice().into_vec();
        drop(datagram);
        drop(receive_permit);
        Ok(result)
    }

    fn close(&self) {
        self.closed.cancel();
    }

    fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
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

fn original_udp_destination(target: &EgressTarget) -> Result<SocketAddr, EgressError> {
    if target.port == 0 {
        return Err(EgressError::InvalidTarget(
            "destination port must be non-zero".into(),
        ));
    }
    let ip = target
        .ip
        .as_deref()
        .and_then(|value| value.trim().parse::<IpAddr>().ok())
        .ok_or_else(|| {
            EgressError::InvalidTarget(
                "DIRECT UDP requires a numeric original destination IP".into(),
            )
        })?;
    Ok(SocketAddr::new(ip, target.port))
}

fn udp_bind_address(destination: IpAddr) -> SocketAddr {
    match destination {
        IpAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        IpAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
    }
}

fn max_udp_datagram_bytes(destination: IpAddr) -> usize {
    match destination {
        IpAddr::V4(_) => MAX_IPV4_UDP_DATAGRAM_BYTES,
        IpAddr::V6(_) => MAX_IPV6_UDP_DATAGRAM_BYTES,
    }
}

fn closed_udp_association_error() -> EgressError {
    EgressError::Unavailable("UDP association is closed".into())
}

fn udp_io_error(operation: &str, error: std::io::Error) -> EgressError {
    EgressError::Connect(format!("UDP {operation} failed ({:?})", error.kind()))
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
    use tokio::net::{TcpListener, UdpSocket};

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

    async fn spawn_udp_echo() -> (String, u16) {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut datagram = vec![0; UDP_RECEIVE_BUFFER_BYTES];
            if let Ok((received, peer)) = socket.recv_from(&mut datagram).await {
                socket.send_to(&datagram[..received], peer).await.unwrap();
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
        let connector = DirectConnector::default();
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
        let connector = DirectConnector::default();
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
    async fn direct_udp_preserves_datagrams_and_returns_safe_metadata() {
        let (ip, port) = spawn_udp_echo().await;
        let connector = DirectConnector::default();
        assert_eq!(connector.udp_capability(), UdpEgressCapability::Supported);

        let egress = connector
            .connect_udp(&EgressTarget {
                host: "must-not-resolve.invalid".into(),
                port,
                ip: Some(ip),
            })
            .await
            .unwrap();
        assert_eq!(
            egress.meta,
            EgressMetadata {
                connector: "direct".into(),
                remote_dns: false,
                tcp_only: false,
                detail: "direct UDP association established".into(),
            }
        );
        let debug = format!("{egress:?}");
        assert!(!debug.contains("127.0.0.1"));
        assert!(!debug.contains("datagram-payload"));

        egress
            .association
            .send(b"datagram-payload".to_vec())
            .await
            .unwrap();
        let received = egress.association.receive().await.unwrap();
        assert_eq!(received, b"datagram-payload");
        assert_eq!(received.capacity(), received.len());
        assert_eq!(
            connector.udp_receive_budget.available_permits(),
            connector.udp_receive_budget_bytes()
        );
    }

    #[test]
    fn direct_udp_receive_budget_has_fail_closed_bounds() {
        assert!(matches!(
            DirectConnector::with_udp_receive_budget(UDP_RECEIVE_BUFFER_BYTES - 1),
            Err(EgressError::Unavailable(_))
        ));
        assert!(matches!(
            DirectConnector::with_udp_receive_budget(MAX_DIRECT_UDP_RECEIVE_BUDGET_BYTES + 1),
            Err(EgressError::Unavailable(_))
        ));

        let connector = DirectConnector::with_udp_receive_budget(UDP_RECEIVE_BUFFER_BYTES).unwrap();
        assert_eq!(
            connector.udp_receive_budget_bytes(),
            UDP_RECEIVE_BUFFER_BYTES
        );
        assert_eq!(
            connector.udp_receive_budget.available_permits(),
            UDP_RECEIVE_BUFFER_BYTES
        );
    }

    #[tokio::test]
    async fn direct_udp_receive_waits_for_the_shared_memory_budget() {
        let (ip, port) = spawn_udp_echo().await;
        let connector = DirectConnector::with_udp_receive_budget(UDP_RECEIVE_BUFFER_BYTES).unwrap();
        let egress = connector
            .connect_udp(&EgressTarget {
                host: String::new(),
                port,
                ip: Some(ip),
            })
            .await
            .unwrap();
        egress.association.send(b"budgeted".to_vec()).await.unwrap();

        let held_budget = Arc::clone(&connector.udp_receive_budget)
            .acquire_many_owned(UDP_RECEIVE_BUFFER_BYTES as u32)
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(25), egress.association.receive())
                .await
                .is_err()
        );
        drop(held_budget);

        let received = tokio::time::timeout(Duration::from_secs(1), egress.association.receive())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received, b"budgeted");
        assert_eq!(received.capacity(), received.len());
        assert_eq!(
            connector.udp_receive_budget.available_permits(),
            UDP_RECEIVE_BUFFER_BYTES
        );
    }

    #[tokio::test]
    async fn direct_udp_rejects_missing_or_non_numeric_original_ip() {
        let connector = DirectConnector::default();
        for ip in [None, Some("target.example".into())] {
            let error = connector
                .connect_udp(&EgressTarget {
                    host: "127.0.0.1".into(),
                    port: 53,
                    ip,
                })
                .await
                .unwrap_err();
            assert!(matches!(error, EgressError::InvalidTarget(_)));
            assert_eq!(error.code(), "invalid_target");
        }
    }

    #[tokio::test]
    async fn direct_udp_rejects_oversized_datagrams_and_closed_io() {
        let (ip, port) = spawn_udp_echo().await;
        let connector = DirectConnector::default();
        let egress = connector
            .connect_udp(&EgressTarget {
                host: String::new(),
                port,
                ip: Some(ip),
            })
            .await
            .unwrap();

        let oversized = egress
            .association
            .send(vec![0; MAX_IPV4_UDP_DATAGRAM_BYTES + 1])
            .await
            .unwrap_err();
        assert!(matches!(oversized, EgressError::InvalidTarget(_)));

        egress.association.close();
        assert!(egress.association.is_closed());
        assert!(matches!(
            egress.association.send(Vec::new()).await.unwrap_err(),
            EgressError::Unavailable(_)
        ));
        assert!(matches!(
            egress.association.receive().await.unwrap_err(),
            EgressError::Unavailable(_)
        ));
    }

    #[test]
    fn direct_udp_uses_an_unspecified_bind_address_for_each_ip_family() {
        assert_eq!(
            udp_bind_address("127.0.0.1".parse().unwrap()),
            "0.0.0.0:0".parse().unwrap()
        );
        assert_eq!(
            udp_bind_address("::1".parse().unwrap()),
            "[::]:0".parse().unwrap()
        );
        assert_eq!(
            max_udp_datagram_bytes("127.0.0.1".parse().unwrap()),
            MAX_IPV4_UDP_DATAGRAM_BYTES
        );
        assert_eq!(
            max_udp_datagram_bytes("::1".parse().unwrap()),
            MAX_IPV6_UDP_DATAGRAM_BYTES
        );
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

    struct PendingUdpConnector;

    #[async_trait]
    impl EgressConnector for PendingUdpConnector {
        fn name(&self) -> &'static str {
            "pending_udp"
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            pending().await
        }

        async fn connect_udp(
            &self,
            _target: &EgressTarget,
        ) -> Result<EgressUdpAssociation, EgressError> {
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

    #[tokio::test]
    async fn udp_connect_deadline_and_cancellation_are_enforced() {
        let timeout = connect_udp_controlled(
            &PendingUdpConnector,
            &inert_target(),
            &ConnectControl::new(Duration::from_millis(5), CancellationToken::new()),
        )
        .await
        .unwrap_err();
        assert!(matches!(timeout, EgressError::Timeout { .. }));

        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let cancelled = connect_udp_controlled(
            &PendingUdpConnector,
            &inert_target(),
            &ConnectControl::new(Duration::from_secs(1), cancellation),
        )
        .await
        .unwrap_err();
        assert!(matches!(cancelled, EgressError::Cancelled { .. }));
    }

    #[tokio::test]
    async fn tcp_only_connectors_fail_closed_for_udp() {
        assert_eq!(
            PendingConnector.udp_capability(),
            UdpEgressCapability::Unsupported
        );
        let error = PendingConnector
            .connect_udp(&inert_target())
            .await
            .unwrap_err();
        assert!(matches!(error, EgressError::Unavailable(_)));

        for connector in [
            proxy_connector(proxy("socks5", 1080)).unwrap(),
            proxy_connector(proxy("http", 8080)).unwrap(),
        ] {
            assert_eq!(connector.udp_capability(), UdpEgressCapability::Unsupported);
            assert!(matches!(
                connector.connect_udp(&inert_target()).await.unwrap_err(),
                EgressError::Unavailable(_)
            ));
        }
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

        assert_eq!(connector.udp_capability(), UdpEgressCapability::Unsupported);

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
